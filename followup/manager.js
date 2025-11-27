import { openDb, closeDb, run, all } from '../db.js';
import { getGHLContactDetails } from '../ghl/api.js';
import { sendNonFatalSlackNotification } from '../slack/notifications.js';
import { LOCATION_ID, FOLLOW_UP_WORKFLOW_ID, OUTGOING_ROUTE_PREFIX } from '../config.js';
import { getValidGoHighlevelToken } from '../ghl/tokens.js';


const FOLLOW_UP_INTERVAL_MS = 60 * 60 * 1000; // Check every hour
const OUTBOUND_CALL_ENDPOINT = `http://127.0.0.1:8000${OUTGOING_ROUTE_PREFIX}/outbound-call`;
const ALLOWED_SERVICES = ["Infissi", "Vetrate", "Pergole"];

// Database helper for follow-ups
export async function saveFollowUp(contactId, followUpAtUTC, province = null, service = null) {
    let db;
    try {
        db = await openDb();
        await run(db, 
            'INSERT INTO follow_ups (contact_id, follow_up_at_utc, status, province, service) VALUES (?, ?, ?, ?, ?)',
            [contactId, followUpAtUTC, 'pending', province, service]
        );
        console.log(`[FollowUp] Saved follow-up for contact ${contactId} at ${followUpAtUTC} (Province: ${province || 'N/A'}, Service: ${service || 'N/A'})`);
        
        // Add contact to follow-up workflow
        try {
            const goHighLevelToken = await getValidGoHighlevelToken(LOCATION_ID);
            if (goHighLevelToken) {
                const workflowResponse = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/workflow/${FOLLOW_UP_WORKFLOW_ID}`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${goHighLevelToken}`,
                        'Version': '2021-07-28',
                        'Content-Type': 'application/json'
                    }
                });
                if (workflowResponse.ok) {
                    console.log(`[GHL WORKFLOW] Successfully added contact ${contactId} to follow-up workflow ${FOLLOW_UP_WORKFLOW_ID}`);
                } else {
                    const errorMessage = `Failed to add contact ${contactId} to follow-up workflow ${FOLLOW_UP_WORKFLOW_ID}: ${workflowResponse.status} ${workflowResponse.statusText}`;
                    console.error(`[GHL WORKFLOW] ${errorMessage}`);
                    await sendNonFatalSlackNotification(
                        'GHL Follow-up Workflow HTTP Error',
                        errorMessage,
                        {
                            contactId,
                            workflowId: FOLLOW_UP_WORKFLOW_ID,
                            status: workflowResponse.status,
                            statusText: workflowResponse.statusText
                        }
                    ).catch(console.error);
                }
            }
        } catch (workflowError) {
            console.error(`[GHL WORKFLOW] Error adding contact ${contactId} to follow-up workflow:`, workflowError);
            await sendNonFatalSlackNotification(
                'GHL Follow-up Workflow Error',
                `Failed to add contact ${contactId} to follow-up workflow`,
                workflowError.message
            ).catch(console.error);
        }
    } catch (error) {
        console.error(`[FollowUp] Error saving follow-up for contact ${contactId}:`, error);
        sendNonFatalSlackNotification(
            'FollowUp DB Error',
            `Error saving follow-up for contact ${contactId}`,
            error.message
        ).catch(console.error);
    } finally {
        await closeDb(db);
    }
}

async function getDueFollowUps() {
    let db;
    try {
        db = await openDb();
        const nowUTC = new Date().toISOString();
        const rows = await all(db, 
            'SELECT follow_up_id, contact_id, follow_up_at_utc, province, service FROM follow_ups WHERE status = ? AND follow_up_at_utc <= ?',
            ['pending', nowUTC]
        );
        return rows;
    } catch (error) {
        console.error('[FollowUp] Error fetching due follow-ups:', error);
        sendNonFatalSlackNotification(
            'FollowUp DB Error',
            'Error fetching due follow-ups',
            error.message
        ).catch(console.error);
        return [];
    } finally {
        await closeDb(db);
    }
}

async function deleteFollowUp(followUpId) {
    let db;
    try {
        db = await openDb();
        await run(db, 'DELETE FROM follow_ups WHERE follow_up_id = ?', [followUpId]);
        console.log(`[FollowUp] Deleted processed follow-up ID ${followUpId}`);
    } catch (error) {
        console.error(`[FollowUp] Error deleting follow-up ID ${followUpId}:`, error);
        sendNonFatalSlackNotification(
            'FollowUp DB Error',
            `Error deleting follow-up ID ${followUpId}`,
            error.message
        ).catch(console.error);
    } finally {
        await closeDb(db);
    }
}

// Clean up follow-ups that might be stuck in infinite retry loops
export async function cleanupStuckFollowUps() {
    let db;
    try {
        db = await openDb();
        const now = new Date();
        const cutoffTime = new Date(now.getTime() - (24 * 60 * 60 * 1000)); // 24 hours ago
        
        // Find follow-ups that have been pending for more than 24 hours (likely stuck)
        const stuckFollowUps = await all(db, 
            'SELECT * FROM follow_ups WHERE status = ? AND follow_up_at_utc < ? ORDER BY follow_up_at_utc ASC',
            ['pending', cutoffTime.toISOString()]
        );
        
        if (stuckFollowUps.length > 0) {
            console.log(`[FollowUp Cleanup] Found ${stuckFollowUps.length} potentially stuck follow-ups older than 24 hours`);
            
            for (const followUp of stuckFollowUps) {
                console.log(`[FollowUp Cleanup] Removing stuck follow-up for contact ${followUp.contact_id} (scheduled: ${followUp.follow_up_at_utc})`);
                
                try {
                    await sendNonFatalSlackNotification(
                        'Cleanup: Stuck FollowUp Removed',
                        `Removed follow-up for contact ${followUp.contact_id} that was stuck since ${followUp.follow_up_at_utc}`,
                        {
                            contactId: followUp.contact_id,
                            originalScheduledTime: followUp.follow_up_at_utc,
                            service: followUp.service,
                            province: followUp.province,
                            reason: 'Auto-cleanup of stuck follow-up older than 24 hours'
                        }
                    );
                } catch (slackError) {
                    console.error('[FollowUp Cleanup] Failed to send cleanup notification:', slackError);
                }
                
                await deleteFollowUp(followUp.follow_up_id);
            }
        } else {
            console.log('[FollowUp Cleanup] No stuck follow-ups found');
        }
    } catch (error) {
        console.error('[FollowUp Cleanup] Error during cleanup:', error);
    } finally {
        if (db) await closeDb(db);
    }
}

// Core logic for checking and processing follow-ups
export async function checkAndProcessFollowUps() {
    console.log("[FollowUp] Checking for due follow-ups...");
    
    // First, clean up any potentially stuck follow-ups
    await cleanupStuckFollowUps();
    
    const dueFollowUps = await getDueFollowUps();

    if (dueFollowUps.length === 0) {
        console.log("[FollowUp] No follow-ups due at this time.");
        return;
    }

    console.log(`[FollowUp] Found ${dueFollowUps.length} follow-ups due. Processing...`);

    for (const followUp of dueFollowUps) {
        console.log(`[FollowUp] Processing follow-up ID ${followUp.follow_up_id} for contact ${followUp.contact_id}. Due: ${followUp.follow_up_at_utc}`);
        try {
            // Fetch contact details for phone number
            const contactDetails = await getGHLContactDetails(LOCATION_ID, followUp.contact_id);

            if (!contactDetails || !contactDetails.phone) {
                console.warn(`[FollowUp - ${followUp.contact_id}] Could not fetch contact details or phone number. Deleting follow-up.`);
                const notificationTitle = 'FollowUp Processing Warning';
                const notificationMessage = `Follow-up for contact ID ${followUp.contact_id} (Due: ${followUp.follow_up_at_utc}) failed: Could not fetch contact details or phone number. Follow-up deleted.`;
                
                // Capture additional error context
                let errorContext = { 
                    contactId: followUp.contact_id, 
                    followUpAtUtc: followUp.follow_up_at_utc,
                    locationId: LOCATION_ID
                };
                
                // Add more context about what exactly failed
                if (!contactDetails) {
                    errorContext.errorType = 'getGHLContactDetails returned null';
                    errorContext.possibleCauses = [
                        'Missing locationId or contactId parameters',
                        'Failed to get valid GHL token for location',
                        'GHL API HTTP error (4xx/5xx response)',
                        'Network exception during API call',
                        'Unexpected GHL API response structure'
                    ];
                    errorContext.debugInfo = {
                        locationId: LOCATION_ID,
                        contactId: followUp.contact_id,
                        note: 'Check server logs for detailed GHL API error messages'
                    };
                } else if (!contactDetails.phone) {
                    errorContext.errorType = 'Contact details found but no phone number';
                    errorContext.contactDetails = contactDetails;
                    errorContext.availableFields = Object.keys(contactDetails);
                }
                
                sendNonFatalSlackNotification(
                    notificationTitle,
                    notificationMessage,
                    errorContext
                ).catch(console.error);
                await deleteFollowUp(followUp.follow_up_id);
                continue; // Skip to next follow-up
            }

            // Use saved service first, then extract from contact's GHL data if not available
            let service = followUp.service; // Use service saved in follow-up record
            
            if (!service) {
                console.log(`[FollowUp - ${followUp.contact_id}] No service saved in follow-up record. Extracting from contact data. Custom fields:`, contactDetails.customFields, 'Tags:', contactDetails.tags);
                
                // First, try to find service in custom fields (case-insensitive)
                if (contactDetails.customFields && Array.isArray(contactDetails.customFields)) {
                    for (const field of contactDetails.customFields) {
                        const value = field.value || field.fieldValue;
                        if (value && typeof value === 'string') {
                            const trimmedValue = value.trim();
                            console.log(`[FollowUp - ${followUp.contact_id}] Checking custom field value: "${trimmedValue}"`);
                            
                            // Find which allowed service is matched, case-insensitively
                            const matchedService = ALLOWED_SERVICES.find(s => s.toLowerCase() === trimmedValue.toLowerCase());
                            if (matchedService) {
                                service = matchedService; // Use the properly capitalized version from ALLOWED_SERVICES
                                console.log(`[FollowUp - ${followUp.contact_id}] Found service in custom fields: "${service}" (matched from "${trimmedValue}")`);
                                break;
                            }
                        }
                    }
                }
                
                // If not found in custom fields, try to find in tags (case-insensitive)
                if (!service && contactDetails.tags && Array.isArray(contactDetails.tags)) {
                    console.log(`[FollowUp - ${followUp.contact_id}] Checking tags for service match:`, contactDetails.tags);
                    
                    for (const tag of contactDetails.tags) {
                        if (tag && typeof tag === 'string') {
                            const trimmedTag = tag.trim();
                            console.log(`[FollowUp - ${followUp.contact_id}] Checking tag: "${trimmedTag}"`);
                            
                            const matchedService = ALLOWED_SERVICES.find(s => s.toLowerCase() === trimmedTag.toLowerCase());
                            if (matchedService) {
                                service = matchedService; // Use the properly capitalized version from ALLOWED_SERVICES
                                console.log(`[FollowUp - ${followUp.contact_id}] Found service in tags: "${service}" (matched from "${trimmedTag}")`);
                                break;
                            }
                        }
                    }
                }
            } else {
                console.log(`[FollowUp - ${followUp.contact_id}] Using saved service from follow-up record: "${service}"`);
            }
            
            // If still no service found, skip this follow-up
            if (!service || service.trim() === '') {
                console.warn(`[FollowUp - ${followUp.contact_id}] No valid service found in contact data. Deleting follow-up.`);
                console.log(`[FollowUp - ${followUp.contact_id}] Raw contact details:`, contactDetails);
                await sendNonFatalSlackNotification(
                    'FollowUp Processing Warning',
                    `Follow-up for contact ID ${followUp.contact_id} failed: No service found in contact data. Follow-up deleted.`,
                    { 
                        contactId: followUp.contact_id, 
                        contactDetails: contactDetails
                    }
                ).catch(console.error);
                await deleteFollowUp(followUp.follow_up_id);
                continue;
            }

            // Validate service is one of the allowed values
            if (!ALLOWED_SERVICES.includes(service)) {
                console.warn(`[FollowUp - ${followUp.contact_id}] Invalid service found: "${service}". Deleting follow-up.`);
                await sendNonFatalSlackNotification(
                    'FollowUp Processing Warning',
                    `Follow-up for contact ID ${followUp.contact_id} failed: Invalid service "${service}". Expected one of: ${ALLOWED_SERVICES.join(', ')}`,
                    { 
                        contactId: followUp.contact_id, 
                        foundService: service,
                        allowedServices: ALLOWED_SERVICES
                    }
                ).catch(console.error);
                await deleteFollowUp(followUp.follow_up_id);
                continue;
            }

            console.log(`[FollowUp - ${followUp.contact_id}] Proceeding with follow-up call for service: ${service}`);

            // Use saved province or try to get it from contact address/city
            let province = followUp.province; // Use province saved in follow-up record
            let fullAddress = contactDetails.address || "";
            let originalCallContext = '';
            
            // Try to get better address information from original call data
            try {
                const { getCallDataByContactId } = await import('../callDataDb.js');
                const originalCallData = await getCallDataByContactId(followUp.contact_id);
                
                if (originalCallData && originalCallData.length > 0) {
                    // Get the most recent call data for this contact
                    const latestCall = originalCallData.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
                    
                    console.log(`[FollowUp - ${followUp.contact_id}] Found original call data from ${latestCall.created_at}`);
                    
                    // If we don't have province from follow-up, try to get it from original call
                    if (!province && latestCall.province) {
                        province = latestCall.province;
                        console.log(`[FollowUp - ${followUp.contact_id}] Using province from original call: "${province}"`);
                    }
                    
                    // Add context about the original call for better AI understanding
                    originalCallContext = ` (Follow-up to previous call on ${new Date(latestCall.created_at).toLocaleDateString('it-IT')})`;
                }
            } catch (originalCallError) {
                console.warn(`[FollowUp - ${followUp.contact_id}] Could not fetch original call data:`, originalCallError.message);
            }
            
            // If no full address but we have city, use city as address
            if (!fullAddress && contactDetails.city) {
                fullAddress = contactDetails.city;
                console.log(`[FollowUp - ${followUp.contact_id}] Using city as address: "${fullAddress}"`);
            }
            
            // Check if we have a placeholder/invalid address and try to get fresh data from GHL
            const { extractProvinceFromAddress } = await import('../utils.js');
            
            // Function to detect if an address is obviously fake/placeholder
            const isPlaceholderAddress = (addr) => {
                if (!addr || typeof addr !== 'string') return true;
                const placeholderPatterns = [
                    /follow-up call/i,
                    /address tbd/i, 
                    /to be determined/i,
                    /placeholder/i,
                    /^n\/a$/i,
                    /^unknown$/i,
                    /^none$/i,
                    /^not provided$/i
                ];
                return placeholderPatterns.some(pattern => pattern.test(addr.trim()));
            };
            
            // If we have a placeholder address and no province yet, try to get fresh address from GHL
            if ((!province && isPlaceholderAddress(fullAddress)) || (!fullAddress || isPlaceholderAddress(fullAddress))) {
                console.log(`[FollowUp - ${followUp.contact_id}] Detected placeholder address "${fullAddress}", fetching fresh contact details from GHL...`);
                
                try {
                    const freshContactDetails = await getGHLContactDetails(LOCATION_ID, followUp.contact_id);
                    if (freshContactDetails && freshContactDetails.address && !isPlaceholderAddress(freshContactDetails.address)) {
                        fullAddress = freshContactDetails.address;
                        console.log(`[FollowUp - ${followUp.contact_id}] Retrieved fresh address from GHL: "${fullAddress}"`);
                        
                        // Now try to extract province from the fresh address
                        if (!province) {
                            province = await extractProvinceFromAddress(fullAddress);
                            console.log(`[FollowUp - ${followUp.contact_id}] Extracted province "${province}" from fresh GHL address: "${fullAddress}"`);
                        }
                    } else {
                        console.log(`[FollowUp - ${followUp.contact_id}] Fresh GHL contact details did not provide a valid address`);
                    }
                } catch (ghlError) {
                    console.warn(`[FollowUp - ${followUp.contact_id}] Failed to fetch fresh contact details from GHL:`, ghlError.message);
                }
            }
            
            // Try to extract province from current address if we still don't have one
            if (!province && fullAddress && !isPlaceholderAddress(fullAddress)) {
                province = await extractProvinceFromAddress(fullAddress);
                console.log(`[FollowUp - ${followUp.contact_id}] Extracted province "${province}" from address: "${fullAddress}"`);
            }
            
            // If we have a saved province but no full address, create a meaningful address with province
            if (province && (!fullAddress || fullAddress.trim() === '')) {
                fullAddress = `Follow-up call, ${province} area${originalCallContext}`;
                console.log(`[FollowUp - ${followUp.contact_id}] Created address with saved province: "${fullAddress}"`);
            }
            
            // Only as last resort, create a generic placeholder
            if (!fullAddress || fullAddress.trim() === '') {
                fullAddress = `Follow-up call${originalCallContext}`;
                console.log(`[FollowUp - ${followUp.contact_id}] Created minimal address for follow-up: "${fullAddress}"`);
            }

            // Create payload with the same format as the main outbound call system
            const payload = {
                phone: contactDetails.phone,
                contact_id: followUp.contact_id,
                first_name: contactDetails.firstName,
                full_name: contactDetails.fullName,
                email: contactDetails.email,
                Service: service,
                full_address: fullAddress
            };

            console.log(`[FollowUp - ${followUp.contact_id}] Triggering outbound call to ${OUTBOUND_CALL_ENDPOINT} with payload:`, payload);

            const response = await fetch(OUTBOUND_CALL_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                timeout: 30000 // 30 second timeout
            });

            if (response.ok) {
                console.log(`[FollowUp - ${followUp.contact_id}] Successfully triggered outbound call (Status: ${response.status}).`);
                // Successfully triggered, delete the follow-up record
                await deleteFollowUp(followUp.follow_up_id);
            } else {
                const errorBody = await response.text();
                
                // Determine if this is a permanent failure that should stop retries
                const isPermanentFailure = response.status === 400 && (
                    errorBody.includes('No sales representatives available') ||
                    errorBody.includes('service and location') ||
                    errorBody.includes('not in right area') ||
                    errorBody.includes('Address is required') ||
                    errorBody.includes('service field is required')
                );
                
                if (isPermanentFailure) {
                    console.log(`[FollowUp - ${followUp.contact_id}] Detected permanent failure (Status: ${response.status}). Deleting follow-up to prevent infinite retries.`);
                    console.log(`[FollowUp - ${followUp.contact_id}] Error details: ${errorBody}`);
                    
                    await sendNonFatalSlackNotification(
                        'FollowUp Permanently Failed - Deleted',
                        `Follow-up for contact ${followUp.contact_id} (${contactDetails.fullName || 'N/A'}) was permanently deleted due to unresolvable issue.`,
                        { 
                            contactId: followUp.contact_id, 
                            fullName: contactDetails.fullName || 'N/A',
                            endpoint: OUTBOUND_CALL_ENDPOINT,
                            status: response.status,
                            errorBody: errorBody,
                            reason: 'Permanent failure - no sales reps available or missing required data'
                        }
                    ).catch(console.error);
                    
                    // Delete the follow-up to stop infinite retries
                    await deleteFollowUp(followUp.follow_up_id);
                } else {
                    // Temporary failure - keep the follow-up for retry
                    console.error(`[FollowUp - ${followUp.contact_id}] Temporary failure (Status: ${response.status}). Follow-up kept for retry.`);
                    console.error(`[FollowUp - ${followUp.contact_id}] Error details: ${errorBody}`);
                    
                    sendNonFatalSlackNotification(
                        'FollowUp Temporary Failure - Will Retry',
                        `Follow-up call for contact ${followUp.contact_id} (${contactDetails.fullName || 'N/A'}) failed temporarily and will be retried.`,
                        { 
                            contactId: followUp.contact_id, 
                            fullName: contactDetails.fullName || 'N/A',
                            endpoint: OUTBOUND_CALL_ENDPOINT,
                            status: response.status,
                            errorBody: errorBody,
                            reason: 'Temporary failure - will retry on next check'
                        }
                    ).catch(console.error);
                }
            }

        } catch (error) {
            console.error(`[FollowUp] Error processing follow-up ID ${followUp.follow_up_id} for contact ${followUp.contact_id}:`, error);
            
            // Provide more specific error context
            let errorContext = {
                errorMessage: error.message,
                contactId: followUp.contact_id,
                followUpId: followUp.follow_up_id,
                endpoint: OUTBOUND_CALL_ENDPOINT,
                errorType: error.name || 'Unknown'
            };
            
            // Add specific context for fetch errors
            if (error.message === 'fetch failed') {
                errorContext.possibleCauses = [
                    'Network connectivity issue',
                    'Server not responding',
                    'Incorrect endpoint URL',
                    'Server overloaded or crashed',
                    'DNS resolution failure'
                ];
                errorContext.troubleshooting = [
                    `Check if server is running on ${OUTBOUND_CALL_ENDPOINT}`,
                    'Verify server is listening on IPv4 (127.0.0.1) not just IPv6',
                    'Check network connectivity',
                    'Review server logs for crashes'
                ];
            }
            
            sendNonFatalSlackNotification(
                'FollowUp Processing Error',
                `Error processing follow-up ID ${followUp.follow_up_id} for contact ${followUp.contact_id}`,
                errorContext
            ).catch(console.error);
            // Decide if you want to delete/mark as failed on error
        }
    }
}

// Function to start the periodic check
export function startFollowUpProcessor(intervalMs = FOLLOW_UP_INTERVAL_MS) {
    console.log(`[FollowUp] Starting follow-up processor. Interval: ${intervalMs / 1000} seconds.`);
    console.log(`[FollowUp] Outbound call endpoint: ${OUTBOUND_CALL_ENDPOINT}`);
    // Initial check
    checkAndProcessFollowUps().catch(err => {
        console.error("[FollowUp Processor] Error during initial check:", err);
        sendNonFatalSlackNotification(
            'FollowUp Processor Error',
            'Error during initial checkAndProcessFollowUps',
            err.message
        ).catch(console.error);
    });
    // Set interval for subsequent checks
    setInterval(() => {
        checkAndProcessFollowUps().catch(err => {
            console.error("[FollowUp Processor] Error during scheduled check:", err);
            sendNonFatalSlackNotification(
                'FollowUp Processor Error',
                'Error during scheduled checkAndProcessFollowUps',
                err.message
            ).catch(console.error);
        });
    }, intervalMs);
}
