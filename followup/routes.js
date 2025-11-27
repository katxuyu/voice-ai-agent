import { saveFollowUp } from './manager.js';
import { parseItalianDateTimeToUTC, extractProvinceFromAddress } from '../utils.js';
import { sendNonFatalSlackNotification } from '../slack/notifications.js';
import { getGHLContactDetails } from '../ghl/api.js';
import { LOCATION_ID } from '../config.js';

export function registerFollowUpRoutes(fastify) {

    // Route to schedule a follow-up call
    fastify.post('/followup', async (request, reply) => {
        const { contactId, followUpDateTime } = request.body;
        console.log(`[FollowUp Route] Received request: contactId=${contactId}, followUpDateTime=${followUpDateTime}`);

        if (!contactId || !followUpDateTime) {
            return reply.code(400).send({ status: "error", message: "Missing required parameters: contactId and followUpDateTime" });
        }

        // Parse the Italian datetime string to UTC
        const followUpAtUTC = parseItalianDateTimeToUTC(followUpDateTime);
        if (!followUpAtUTC) {
            return reply.code(400).send({ status: "error", message: "Invalid followUpDateTime format. Expected 'DD-MM-YYYY HH:mm'" });
        }

        // Validate if the parsed date is in the future
        if (followUpAtUTC <= new Date()) {
             return reply.code(400).send({ status: "error", message: "Follow-up date must be in the future." });
        }
       
        try {
            // Try to get province and service from contact details
            let province = null;
            let service = null;
            
            try {
                const contactDetails = await getGHLContactDetails(LOCATION_ID, contactId);
                if (contactDetails) {
                    // Extract service from custom fields or tags
                    const ALLOWED_SERVICES = ["Infissi", "Vetrate", "Pergole"];
                    if (contactDetails.customFields && Array.isArray(contactDetails.customFields)) {
                        for (const field of contactDetails.customFields) {
                            const value = field.value || field.fieldValue;
                            if (value && typeof value === 'string') {
                                const matchedService = ALLOWED_SERVICES.find(s => s.toLowerCase() === value.trim().toLowerCase());
                                if (matchedService) {
                                    service = matchedService;
                                    console.log(`[FollowUp Route] Found service in custom fields: "${service}"`);
                                    break;
                                }
                            }
                        }
                    }
                    
                    // Try tags if not found in custom fields
                    if (!service && contactDetails.tags && Array.isArray(contactDetails.tags)) {
                        for (const tag of contactDetails.tags) {
                            if (tag && typeof tag === 'string') {
                                const matchedService = ALLOWED_SERVICES.find(s => s.toLowerCase() === tag.trim().toLowerCase());
                                if (matchedService) {
                                    service = matchedService;
                                    console.log(`[FollowUp Route] Found service in tags: "${service}"`);
                                    break;
                                }
                            }
                        }
                    }
                    
                    // Extract province from address
                    if (contactDetails.address) {
                        province = await extractProvinceFromAddress(contactDetails.address);
                        console.log(`[FollowUp Route] Extracted province from address: "${province}"`);
                    }
                    
                    console.log(`[FollowUp Route] Contact analysis complete - Service: ${service || 'N/A'}, Province: ${province || 'N/A'}`);
                }
            } catch (contactError) {
                console.warn(`[FollowUp Route] Could not fetch contact details for ${contactId}:`, contactError.message);
                // Continue without province/service - they'll be extracted during follow-up processing
            }
            
            await saveFollowUp(contactId, followUpAtUTC.toISOString(), province, service);
            const successMessage = `Follow-up scheduled for contact ${contactId} at ${followUpDateTime} (UTC: ${followUpAtUTC.toISOString()})${service ? ` - Service: ${service}` : ''}${province ? ` - Province: ${province}` : ''}`;
            console.log(`[FollowUp Route] ${successMessage}`);
            return reply.code(201).send({ status: "success", message: successMessage });
        } catch (error) {
            console.error(`[FollowUp Route] Error in /followup endpoint:`, error);
            // Notify Slack about the error
            sendNonFatalSlackNotification(
                'FollowUp Route Error',
                `Error in /followup endpoint for contactId: ${contactId}`,
                error.message
            ).catch(console.error);
            return reply.code(500).send({ status: "error", message: "Failed to schedule follow-up." });
        }
    });

    // Manual trigger endpoint for testing follow-up processing
    fastify.post('/followup/trigger', async (request, reply) => {
        console.log(`[FollowUp Route] Manual trigger requested`);
        
        try {
            // Import the checkAndProcessFollowUps function
            const { checkAndProcessFollowUps } = await import('./manager.js');
            
            // Trigger the follow-up processing manually
            await checkAndProcessFollowUps();
            
            return reply.code(200).send({ 
                status: "success", 
                message: "Follow-up processing triggered successfully" 
            });
        } catch (error) {
            console.error(`[FollowUp Route] Error in manual trigger:`, error);
            sendNonFatalSlackNotification(
                'FollowUp Manual Trigger Error',
                'Error in manual follow-up trigger endpoint',
                error.message
            ).catch(console.error);
            return reply.code(500).send({ 
                status: "error", 
                message: "Failed to trigger follow-up processing" 
            });
        }
    });
} 