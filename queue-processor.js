import Twilio from 'twilio';
import { openDb, closeDb, run, get as getDbRecord, all as getAllDbRecords } from './db.js';
import { getValidGoHighlevelToken } from './ghl/tokens.js';
import { addGHLContactNote } from './ghl/api.js';
import { sendNonFatalSlackNotification } from './slack/notifications.js';
import { setCallData } from './callDataDb.js'; // Use exported function
import { LOCATION_ID, ITALIAN_TIMEZONE } from './config.js';

const { 
    TWILIO_ACCOUNT_SID, 
    TWILIO_AUTH_TOKEN, 
    MAX_ACTIVE_CALLS = 3 // Default if not set in env
} = process.env;

const PROCESSING_INTERVAL_MS = 10 * 1000; // Check every 10 seconds
const MAX_ACTIVE = parseInt(MAX_ACTIVE_CALLS, 10);

// Helper function to add call attempt notes to GoHighLevel
async function addCallAttemptNote(contactId, attemptNumber, phoneNumber, service, reason = 'call_execution') {
    if (!contactId) {
        console.warn("[QUEUE PROCESSOR NOTE] No contactId provided, skipping note addition");
        return;
    }

    const currentDateTime = new Date().toLocaleString('it-IT', { 
        timeZone: ITALIAN_TIMEZONE,
        day: '2-digit',
        month: '2-digit', 
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });

    let noteBody;
    if (attemptNumber === 0) {
        noteBody = `📞 Chiamata iniziale in corso - ${currentDateTime}\n` +
                   `Numero: ${phoneNumber}\n` +
                   `Servizio: ${service}\n` +
                   `Sistema: Chiamata automatica avviata`;
    } else {
        noteBody = `📞 Richiamata #${attemptNumber} in corso - ${currentDateTime}\n` +
                   `Numero: ${phoneNumber}\n` +
                   `Servizio: ${service}\n` +
                   `Sistema: Chiamata automatica avviata`;
    }

    try {
        const result = await addGHLContactNote(LOCATION_ID, contactId, noteBody);
        if (result.success) {
            console.log(`[QUEUE PROCESSOR NOTE] Successfully added call execution note for contact ${contactId} (attempt ${attemptNumber})`);
        } else {
            console.error(`[QUEUE PROCESSOR NOTE] Failed to add call execution note for contact ${contactId}:`, result.error);
            await sendNonFatalSlackNotification(
                'GHL Queue Processor Call Note Error',
                `Failed to add call execution note for contact ${contactId}`,
                result
            ).catch(console.error);
        }
    } catch (error) {
        console.error(`[QUEUE PROCESSOR NOTE] Exception adding call execution note for contact ${contactId}:`, error);
        await sendNonFatalSlackNotification(
            'GHL Queue Processor Call Note Exception',
            `Exception adding call execution note for contact ${contactId}`,
            error.message
        ).catch(console.error);
    }
}

async function countActiveTwilioCalls(twilioClient) {
    if (!twilioClient) {
        console.error("[Queue Processor] countActiveTwilioCalls called without a valid Twilio client.");
        return MAX_ACTIVE; // Assume max if client is missing
    }
    try {
        // Use the passed client instance
        const calls = await twilioClient.calls.list({
            status: ['queued', 'ringing', 'in-progress'],
            limit: MAX_ACTIVE + 5 
        });
        return calls.length;
    } catch (error) {
        console.error(`[Queue Processor] Error fetching active calls from Twilio:`, error);
        // Log if credentials seem missing in the client's context, if possible (might be internal)
        if (error.message.includes("username is required") || error.message.includes("authenticate")) {
             console.error(`[Queue Processor] Authentication error suggests SID/Token might be missing or invalid for the client instance.`);
        }
        sendNonFatalSlackNotification(
            'Queue Processor - Twilio API Error',
            `Failed to fetch active calls from Twilio API`,
            {
                error: error.message,
                stack: error.stack,
                isAuthError: error.message.includes("username is required") || error.message.includes("authenticate"),
                function: 'countActiveTwilioCalls'
            }
        ).catch(console.error);
        return MAX_ACTIVE; // Assume max if Twilio check fails to prevent overload
    }
}

async function processCallQueue(twilioClient) {
    if (!twilioClient) {
        console.error("[Queue Processor] processCallQueue called without a valid Twilio client.");
        return; 
    }
    let db;
    // console.log("[Queue Processor] Checking for pending calls..."); // Too noisy for interval

    try {
        // Pass client to countActiveTwilioCalls
        const currentActiveCalls = await countActiveTwilioCalls(twilioClient); 
        // console.log(`[Queue Processor] Current active calls (Twilio): ${currentActiveCalls}`);
        const availableSlots = MAX_ACTIVE - currentActiveCalls;

        if (availableSlots <= 0) {
            // console.log("[Queue Processor] Max active calls reached. Waiting for next interval.");
            return;
        }

        db = await openDb();
        const now_iso = new Date().toISOString();

        // Get calls ready to be processed (oldest first)
        const pendingCalls = await getAllDbRecords(db,
            `SELECT * FROM call_queue 
             WHERE status = 'pending' AND scheduled_at <= ? 
             ORDER BY scheduled_at ASC 
             LIMIT ?`,
            [now_iso, availableSlots]
        );

        if (pendingCalls.length === 0) {
            // console.log("[Queue Processor] No pending calls ready to process.");
            await closeDb(db); // Close DB if no calls found
            return;
        }

        console.log(`[Queue Processor] Found ${pendingCalls.length} calls to process (Available slots: ${availableSlots}).`);

        // Process calls sequentially to avoid race conditions on DB updates within the loop
        for (const callJob of pendingCalls) {
            console.log(`[Queue Processor] Processing job ID: ${callJob.queue_id} for ${callJob.phone_number}`);
            let jobProcessedSuccessfully = false;
            
            // Check for GoHighLevel token before processing the call
            try {
                const goHighLevelToken = await getValidGoHighlevelToken(LOCATION_ID);
                if (!goHighLevelToken) {
                    const errorMessage = `No GoHighLevel tokens found for location ${LOCATION_ID}. Cannot process queued call for contact ${callJob.contact_id} (${callJob.full_name || callJob.first_name || 'Unknown'}).`;
                    console.error(`[QUEUE PROCESSOR] ${errorMessage}`);
                    
                    try {
                        await sendNonFatalSlackNotification(
                            'Queue Processor - GHL Token Missing',
                            errorMessage,
                            {
                                queueId: callJob.queue_id,
                                contactId: callJob.contact_id,
                                fullName: callJob.full_name || callJob.first_name || 'Unknown',
                                phone: callJob.phone_number,
                                service: callJob.service,
                                locationId: LOCATION_ID
                            }
                        );
                    } catch (slackError) {
                        console.error('[QUEUE PROCESSOR] Failed to send GHL token missing notification to Slack:', slackError);
                    }
                    
                    // Mark job as failed due to missing GHL token
                    try {
                        await run(db,
                            `UPDATE call_queue SET status = 'failed', last_error = ? WHERE queue_id = ?`,
                            ['GoHighLevel tokens not available', callJob.queue_id]
                        );
                    } catch (failUpdateError) {
                        console.error(`[Queue Processor] Error marking job ${callJob.queue_id} as failed due to missing GHL token:`, failUpdateError);
                    }
                    
                    continue; // Skip this job and move to the next one
                }
            } catch (tokenCheckError) {
                console.error(`[Queue Processor] Error checking GHL token for job ${callJob.queue_id}:`, tokenCheckError);
                continue; // Skip this job if token check fails
            }
            
            // Mark as processing immediately 
            try {
                 await run(db, 
                    `UPDATE call_queue SET status = 'processing', last_attempt_at = ? WHERE queue_id = ? AND status = 'pending'`,
                    [new Date().toISOString(), callJob.queue_id]
                );
            } catch (updateError) {
                 console.error(`[Queue Processor] Error marking job ${callJob.queue_id} as processing:`, updateError);
                 continue; // Skip this job if update fails
            }

            try {
                // Make the actual call via Twilio
                let callRecord;
                console.log(`[QUEUE PROCESSOR] Making call to ${callJob.phone_number} with options:`, callJob.call_options_json);
                const callOptions = JSON.parse(callJob.call_options_json);
                callRecord = await twilioClient.calls.create(callOptions);
                console.log(`[QUEUE PROCESSOR] Twilio call initiated. SID: ${callRecord.sid} for Number: ${callJob.phone_number}, Contact ID: ${callJob.contact_id}`);

                // CRITICAL: Store initial call data IMMEDIATELY after Twilio call creation
                // This prevents race condition where status callbacks arrive before call data is stored
                await setCallData(callRecord.sid, {
                  to: callJob.phone_number,
                  contactId: callJob.contact_id,
                  retry_count: callJob.retry_stage, // Store the current attempt number (0-indexed)
                  status: 'initiated', // Initial status from our end
                  created_at: new Date().toISOString(),
                  signedUrl: callJob.initial_signed_url, // From the queue job
                  fullName: callJob.full_name,
                  firstName: callJob.first_name,
                  email: callJob.email,
                  availableSlots: callJob.available_slots_text,
                  // Ensure first_attempt_timestamp from the queue job is passed here
                  first_attempt_timestamp: callJob.first_attempt_timestamp,
                  service: callJob.service, // Add service information
                  province: callJob.province // Add province information for AI context
                });
                console.log(`[QUEUE PROCESSOR] Stored initial call data for SID ${callRecord.sid} with retry_count: ${callJob.retry_stage}, first_attempt_timestamp: ${callJob.first_attempt_timestamp}, and available_slots: ${callJob.available_slots_text ? callJob.available_slots_text.substring(0, 100) + '...' : 'None'}`);

                // Add call execution note to GoHighLevel (moved after call data storage to prevent race condition)
                await addCallAttemptNote(callJob.contact_id, callJob.retry_stage, callJob.phone_number, callJob.service, 'call_execution');

                // Remove from queue upon successful initiation
                await run(db, `DELETE FROM call_queue WHERE queue_id = ?`, [callJob.queue_id]);
                console.log(`[Queue Processor] Removed job ${callJob.queue_id} from queue.`);
                jobProcessedSuccessfully = true;

            } catch (callError) {
                console.error(`[Queue Processor] Error initiating Twilio call for job ${callJob.queue_id}:`, callError);
                const errorMessage = callError.message || 'Unknown call initiation error';
                sendNonFatalSlackNotification(
                    'Queue Processor - Call Initiation Error',
                    `Failed to initiate Twilio call for queued job`,
                    {
                        queueId: callJob.queue_id,
                        contactId: callJob.contact_id,
                        phoneNumber: callJob.phone_number,
                        fullName: callJob.full_name || callJob.first_name || 'Unknown',
                        service: callJob.service,
                        retryStage: callJob.retry_stage,
                        error: errorMessage,
                        stack: callError.stack
                    }
                ).catch(console.error);
                // Mark as failed in the queue
                try {
                    await run(db,
                        `UPDATE call_queue SET status = 'failed', last_error = ? WHERE queue_id = ?`,
                        [errorMessage, callJob.queue_id]
                    );
                } catch (failUpdateError) {
                     console.error(`[Queue Processor] Error marking job ${callJob.queue_id} as failed:`, failUpdateError);
                }
            }
        }

    } catch (error) {
        console.error("[Queue Processor] Error during queue processing cycle:", error);
        sendNonFatalSlackNotification(
            'Queue Processor - Processing Cycle Error',
            `Critical error during queue processing cycle`,
            {
                error: error.message,
                stack: error.stack,
                function: 'processCallQueue',
                critical: true
            }
        ).catch(console.error);
    } finally {
        // Ensure DB is closed if it was opened
        if (db && !db.open) { // Check if already closed or failed to open
             // No action needed
        } else if (db) {
            await closeDb(db);
        }
    }
}

// Function to start the periodic queue processor
export function startQueueProcessor(intervalMs = PROCESSING_INTERVAL_MS) {
    // Create the Twilio client HERE
    const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    console.log(`[Queue Processor] Starting queue processing. Interval: ${intervalMs / 1000} seconds. Max Active Calls: ${MAX_ACTIVE}`);
    
    // Ensure interval is reasonable
    const safeInterval = Math.max(intervalMs, 5000); // Minimum 5 seconds

    // Initial run, pass the client
    processCallQueue(twilioClient).catch(console.error); 
    
    // Set interval for subsequent runs, pass the client
    setInterval(() => { 
        processCallQueue(twilioClient).catch(console.error);
    }, safeInterval);
} 