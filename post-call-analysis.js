import { GEMINI_API_KEY, GOHIGHLEVEL_LOCATION_ID, GOHIGHLEVEL_CALENDAR_ID, ITALIAN_TIMEZONE } from './config.js';
import { bookGHLAppointmentWithUser, fetchGHLCalendarSlotsForUsers, getGHLContactDetails, addGHLContactNote } from './ghl/api.js';
import { sendNonFatalSlackNotification, sendPositiveSlackNotification } from './slack/notifications.js';
import { saveFollowUp } from './followup/manager.js';
import { extractProvinceFromAddress } from './utils.js';

/**
 * Post-Call Analysis System
 * 
 * This system analyzes completed call transcripts to identify missed tool calls
 * and executes them after the call ends. This addresses LLM inconsistency
 * during live conversations by providing a safety net for critical actions.
 */

const ANALYSIS_RETRY_ATTEMPTS = 3;
const FOLLOW_UP_DELAY_HOURS = 24;

/**
 * Analyzes conversation transcript using Gemini AI to detect missed actions
 * @param {Array} transcript - Array of conversation messages
 * @param {Object} contactInfo - Contact information from dynamic variables
 * @param {string} conversationId - ElevenLabs conversation ID
 * @returns {Object} Analysis results with detected actions
 */
async function analyzeTranscriptForMissedActions(transcript, contactInfo, conversationId) {
    if (!GEMINI_API_KEY || GEMINI_API_KEY.trim() === '') {
        console.warn(`[POST-CALL ANALYSIS] No Gemini API key configured, using mock analysis for conversation ${conversationId}`);
        
        // Simple mock analysis for testing when no API key is available
        const conversationText = transcript
            .filter(msg => msg && msg.message && msg.role)
            .map(msg => msg.message.toLowerCase())
            .join(' ');
            
        // Basic keyword detection for demo purposes
        const hasAppointmentAgreement = /va bene|d'accordo|perfetto|confermo|giovedì|lunedì|martedì|mercoledì|venerdì|sabato|domenica|alle \d{1,2}/.test(conversationText);
        const hasAddress = /via |corso |piazza |strada /i.test(conversationText);
        
        return {
            needsAppointment: hasAppointmentAgreement,
            appointmentDetails: {
                customerAgreed: hasAppointmentAgreement,
                preferredTimeframe: hasAppointmentAgreement ? "detected from conversation" : null,
                urgency: "medium",
                reasoning: hasAppointmentAgreement ? "Mock analysis detected appointment agreement keywords" : "No appointment keywords detected"
            },
            needsFollowUp: false,
            followUpDetails: {
                customerInterested: false,
                suggestedDelay: null,
                reasoning: "Mock analysis - no follow-up logic"
            },
            needsContactUpdate: hasAddress,
            contactUpdateDetails: {
                newAddress: hasAddress ? "Address detected in conversation (mock analysis)" : null,
                additionalNotes: "Mock analysis performed due to missing Gemini API key",
                serviceDetails: null
            },
            overallAssessment: `Mock analysis: ${hasAppointmentAgreement ? 'appointment agreement detected' : 'no clear appointment agreement'}, ${hasAddress ? 'address mentioned' : 'no address detected'}`
        };
    }
    
    console.log(`[POST-CALL ANALYSIS] Using Gemini 2.0 Flash (stable latest model) for analysis of conversation ${conversationId}`);

    if (!transcript || !Array.isArray(transcript) || transcript.length === 0) {
        console.warn(`[POST-CALL ANALYSIS] No valid transcript provided for conversation ${conversationId}`);
        return { needsAppointment: false, needsFollowUp: false, needsContactUpdate: false };
    }

    try {
        // Convert transcript to readable format for analysis and detect tool usage
        let toolsUsedDuringCall = [];
        const conversationText = transcript
            .filter(msg => msg && msg.message && msg.role)
            .map(msg => {
                // Track if any tools were called during the conversation
                if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                    msg.tool_calls.forEach(toolCall => {
                        if (toolCall && toolCall.function && toolCall.function.name) {
                            toolsUsedDuringCall.push(toolCall.function.name);
                        }
                    });
                }
                return `${msg.role.toUpperCase()}: ${msg.message}`;
            })
            .join('\n');

        if (!conversationText.trim()) {
            console.warn(`[POST-CALL ANALYSIS] Empty conversation text for ${conversationId}`);
            return { needsAppointment: false, needsFollowUp: false, needsContactUpdate: false };
        }

        console.log(`[POST-CALL ANALYSIS] Tools used during call ${conversationId}:`, toolsUsedDuringCall);

        const analysisPrompt = `
You are an expert call analysis system for an Italian home improvement company. Analyze this completed sales call transcript to identify missed actions that should be executed post-call.

CONTEXT:
- Company services: Infissi (windows/doors), Vetrate (glass walls), Pergole (pergolas)
- Goal: Book in-person consultations with customers
- AI agent can book appointments, schedule follow-ups, and update contact info during calls
- Problem: Tool calling is inconsistent during live conversations

TOOLS USED DURING CALL:
${toolsUsedDuringCall.length > 0 ? toolsUsedDuringCall.join(', ') : 'No tools were called during this conversation'}

TRANSCRIPT:
${conversationText}

CONTACT INFO:
Name: ${contactInfo.fullName || contactInfo.firstName || 'Unknown'}
Phone: ${contactInfo.phone || 'Unknown'}
Service Interest: ${contactInfo.service || 'Unknown'}

ANALYSIS TASK:
Determine if any of these actions were missed during the call:

1. APPOINTMENT BOOKING: Did the customer agree to book an appointment but it wasn't actually scheduled?
   - IMPORTANT: If booking tools (like "book_appointment") were already called during the call, do NOT set needsAppointment=true
   - Only suggest booking if customer clearly agreed AND no booking tools were used
   
2. FOLLOW-UP SCHEDULING: Did the customer show interest but want to think about it or call back later?
3. CONTACT UPDATES: Did the customer provide additional details (address, preferences) that should be saved?

Respond with a JSON object containing:
{
  "needsAppointment": boolean,
  "appointmentDetails": {
    "customerAgreed": boolean,
    "preferredTimeframe": "string or null",
    "urgency": "high|medium|low",
    "reasoning": "why they agreed to appointment"
  },
  "needsFollowUp": boolean,
  "followUpDetails": {
    "customerInterested": boolean,
    "suggestedDelay": "24h|48h|1week",
    "reasoning": "why follow-up is needed"
  },
  "needsContactUpdate": boolean,
  "contactUpdateDetails": {
    "newAddress": "string or null",
    "additionalNotes": "string or null",
    "serviceDetails": "string or null"
  },
  "overallAssessment": "brief summary of what happened and what needs to be done"
}

IMPORTANT:
- Only set needsAppointment=true if customer CLEARLY agreed to meet
- Only set needsFollowUp=true if customer was interested but not ready to book
- Only set needsContactUpdate=true if new information was provided
- Be conservative - don't assume agreement unless explicitly stated
- Focus on Italian conversation patterns and politeness markers
`;

        let analysisResult;
        let lastError;

        // Retry analysis up to ANALYSIS_RETRY_ATTEMPTS times
        for (let attempt = 1; attempt <= ANALYSIS_RETRY_ATTEMPTS; attempt++) {
            try {
                console.log(`[POST-CALL ANALYSIS] Attempt ${attempt}/${ANALYSIS_RETRY_ATTEMPTS} for conversation ${conversationId}`);

                const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        contents: [{
                            parts: [{
                                text: analysisPrompt
                            }]
                        }],
                        generationConfig: {
                            temperature: 0.1, // Low temperature for consistent analysis
                            maxOutputTokens: 1000,
                        }
                    })
                });

                if (!response.ok) {
                    throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
                }

                const data = await response.json();
                
                // Success - got valid response from Gemini 2.0 Flash
                
                if (!data.candidates || !Array.isArray(data.candidates) || data.candidates.length === 0) {
                    throw new Error(`Invalid response structure: missing or empty candidates array. Response: ${JSON.stringify(data)}`);
                }
                
                if (!data.candidates[0].content) {
                    throw new Error(`Invalid response structure: missing content in candidate. Candidate: ${JSON.stringify(data.candidates[0])}`);
                }
                
                if (!data.candidates[0].content.parts || !Array.isArray(data.candidates[0].content.parts) || data.candidates[0].content.parts.length === 0) {
                    throw new Error(`Invalid response structure: missing or empty parts array. Content: ${JSON.stringify(data.candidates[0].content)}`);
                }

                const analysisText = data.candidates[0].content.parts[0].text;
                
                // Extract JSON from the response
                const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
                if (!jsonMatch) {
                    throw new Error('No JSON found in Gemini response');
                }

                analysisResult = JSON.parse(jsonMatch[0]);
                
                // Validate required fields
                if (typeof analysisResult.needsAppointment !== 'boolean' ||
                    typeof analysisResult.needsFollowUp !== 'boolean' ||
                    typeof analysisResult.needsContactUpdate !== 'boolean') {
                    throw new Error('Invalid analysis result structure');
                }

                console.log(`[POST-CALL ANALYSIS] Successfully analyzed conversation ${conversationId} on attempt ${attempt}`);
                break;

            } catch (error) {
                lastError = error;
                console.error(`[POST-CALL ANALYSIS] Attempt ${attempt} failed for conversation ${conversationId}:`, error.message);
                
                if (attempt === ANALYSIS_RETRY_ATTEMPTS) {
                    throw error;
                }
                
                // Wait before retry (exponential backoff)
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            }
        }

        if (!analysisResult) {
            throw lastError || new Error('Failed to get analysis result after all attempts');
        }

        console.log(`[POST-CALL ANALYSIS] Analysis result for ${conversationId}:`, JSON.stringify(analysisResult, null, 2));
        return analysisResult;

    } catch (error) {
        console.error(`[POST-CALL ANALYSIS] Critical error analyzing conversation ${conversationId}:`, error);
        
        await sendNonFatalSlackNotification(
            'Post-Call Analysis Failed',
            `Failed to analyze transcript for conversation ${conversationId}`,
            {
                conversationId,
                error: error.message,
                contactInfo,
                transcriptLength: transcript.length
            }
        ).catch(console.error);

        // Return safe defaults
        return { needsAppointment: false, needsFollowUp: false, needsContactUpdate: false };
    }
}

/**
 * Attempts to book an appointment post-call based on analysis results
 * @param {Object} analysis - Analysis results from transcript
 * @param {Object} contactInfo - Contact information
 * @param {string} conversationId - ElevenLabs conversation ID
 * @returns {Object} Booking result
 */
async function executePostCallAppointmentBooking(analysis, contactInfo, conversationId) {
    if (!analysis.needsAppointment || !analysis.appointmentDetails?.customerAgreed) {
        return { success: false, reason: 'No appointment needed based on analysis' };
    }

    const contactId = contactInfo.contactId;
    if (!contactId) {
        return { success: false, reason: 'No contact ID available for booking' };
    }

    try {
        console.log(`[POST-CALL BOOKING] Attempting to book appointment for conversation ${conversationId}, contact ${contactId}`);

        // Get fresh contact details and determine province/service
        const contactDetails = await getGHLContactDetails(GOHIGHLEVEL_LOCATION_ID, contactId);
        if (!contactDetails) {
            return { success: false, reason: 'Could not fetch contact details from GHL' };
        }

        // Determine service
        let service = contactInfo.service;
        if (!service && contactDetails.customFields) {
            // Try to extract service from custom fields
            for (const field of contactDetails.customFields) {
                const value = field.value || field.fieldValue;
                if (value && ['Infissi', 'Vetrate', 'Pergole'].includes(value)) {
                    service = value;
                    break;
                }
            }
        }

        if (!service) {
            return { success: false, reason: 'No service information available for booking' };
        }

        // Determine province for agent assignment
        let province = null;
        if (contactDetails.address) {
            province = await extractProvinceFromAddress(contactDetails.address);
        }

        // Get available calendar slots (next 7 days)
        const startDate = new Date();
        const endDate = new Date();
        endDate.setDate(startDate.getDate() + 7);

        const startDateISO = startDate.toISOString().split('T')[0];
        const endDateISO = endDate.toISOString().split('T')[0];

        // Import service to user mapping
        const { SERVICE_TO_USER_IDS } = await import('./config.js');
        const userIds = SERVICE_TO_USER_IDS[service] || [];

        let availableSlots = [];
        if (userIds.length > 0) {
            availableSlots = await fetchGHLCalendarSlotsForUsers(
                GOHIGHLEVEL_LOCATION_ID,
                GOHIGHLEVEL_CALENDAR_ID,
                startDateISO,
                endDateISO,
                userIds
            );
        }

        if (!availableSlots || availableSlots.length === 0) {
            // Schedule follow-up if no slots available
            const followUpDelay = new Date();
            followUpDelay.setHours(followUpDelay.getHours() + FOLLOW_UP_DELAY_HOURS);
            
            await saveFollowUp(contactId, followUpDelay.toISOString(), province, service);
            
            return { 
                success: false, 
                reason: 'No available calendar slots - follow-up scheduled',
                followUpScheduled: true
            };
        }

        // Book the earliest available slot
        const earliestSlot = availableSlots[0];
        const appointmentTime = new Date(earliestSlot.datetime);
        const userId = earliestSlot.userId;

        const bookingResult = await bookGHLAppointmentWithUser(
            GOHIGHLEVEL_LOCATION_ID,
            GOHIGHLEVEL_CALENDAR_ID,
            contactId,
            appointmentTime,
            userId,
            contactDetails.address || analysis.contactUpdateDetails?.newAddress
        );

        if (bookingResult.success) {
            // Add note about post-call booking
            const noteText = `📞 APPUNTAMENTO PRENOTATO POST-CHIAMATA - ${new Date().toLocaleString('it-IT', { timeZone: ITALIAN_TIMEZONE })}\n\n` +
                           `✅ Appuntamento confermato automaticamente dopo analisi della chiamata\n` +
                           `📅 Data: ${appointmentTime.toLocaleString('it-IT', { timeZone: ITALIAN_TIMEZONE })}\n` +
                           `🎯 Servizio: ${service}\n` +
                           `📊 Motivo: ${analysis.appointmentDetails.reasoning || 'Cliente ha confermato interesse'}\n` +
                           `🆔 Conversazione: ${conversationId}`;

            await addGHLContactNote(GOHIGHLEVEL_LOCATION_ID, contactId, noteText);

            await sendPositiveSlackNotification(
                'Post-Call Appointment Booked Successfully',
                `Automatically booked appointment after call analysis for ${contactDetails.fullName || contactDetails.firstName}`,
                {
                    conversationId,
                    contactId,
                    contactName: contactDetails.fullName || contactDetails.firstName,
                    service,
                    appointmentTime: appointmentTime.toISOString(),
                    userId,
                    analysisReasoning: analysis.appointmentDetails.reasoning
                }
            );

            return { 
                success: true, 
                appointmentTime: appointmentTime.toISOString(),
                userId,
                bookingData: bookingResult.data
            };
        } else {
            return { 
                success: false, 
                reason: `Booking failed: ${bookingResult.error}`,
                details: bookingResult
            };
        }

    } catch (error) {
        console.error(`[POST-CALL BOOKING] Error booking appointment for conversation ${conversationId}:`, error);
        
        await sendNonFatalSlackNotification(
            'Post-Call Booking Failed',
            `Failed to execute post-call appointment booking for conversation ${conversationId}`,
            {
                conversationId,
                contactId,
                error: error.message,
                stack: error.stack
            }
        ).catch(console.error);

        return { success: false, reason: `Booking exception: ${error.message}` };
    }
}

/**
 * Schedules a follow-up call based on analysis results
 * @param {Object} analysis - Analysis results from transcript
 * @param {Object} contactInfo - Contact information
 * @param {string} conversationId - ElevenLabs conversation ID
 * @returns {Object} Follow-up scheduling result
 */
async function executePostCallFollowUp(analysis, contactInfo, conversationId) {
    if (!analysis.needsFollowUp || !analysis.followUpDetails?.customerInterested) {
        return { success: false, reason: 'No follow-up needed based on analysis' };
    }

    const contactId = contactInfo.contactId;
    if (!contactId) {
        return { success: false, reason: 'No contact ID available for follow-up' };
    }

    try {
        // Determine follow-up delay
        let delayHours = FOLLOW_UP_DELAY_HOURS;
        if (analysis.followUpDetails.suggestedDelay) {
            switch (analysis.followUpDetails.suggestedDelay) {
                case '24h': delayHours = 24; break;
                case '48h': delayHours = 48; break;
                case '1week': delayHours = 168; break;
            }
        }

        const followUpTime = new Date();
        followUpTime.setHours(followUpTime.getHours() + delayHours);

        // Get province and service for follow-up
        let province = null;
        const service = contactInfo.service;

        if (contactInfo.fullAddress) {
            province = await extractProvinceFromAddress(contactInfo.fullAddress);
        }

        await saveFollowUp(contactId, followUpTime.toISOString(), province, service);

        // Add note about scheduled follow-up
        const noteText = `📞 FOLLOW-UP PROGRAMMATO POST-CHIAMATA - ${new Date().toLocaleString('it-IT', { timeZone: ITALIAN_TIMEZONE })}\n\n` +
                       `⏰ Follow-up automatico programmato per: ${followUpTime.toLocaleString('it-IT', { timeZone: ITALIAN_TIMEZONE })}\n` +
                       `📊 Motivo: ${analysis.followUpDetails.reasoning || 'Cliente interessato ma non pronto per appuntamento'}\n` +
                       `🆔 Conversazione: ${conversationId}`;

        await addGHLContactNote(GOHIGHLEVEL_LOCATION_ID, contactId, noteText);

        console.log(`[POST-CALL FOLLOW-UP] Scheduled follow-up for conversation ${conversationId}, contact ${contactId} at ${followUpTime.toISOString()}`);

        return { 
            success: true, 
            followUpTime: followUpTime.toISOString(),
            delayHours,
            reasoning: analysis.followUpDetails.reasoning
        };

    } catch (error) {
        console.error(`[POST-CALL FOLLOW-UP] Error scheduling follow-up for conversation ${conversationId}:`, error);
        return { success: false, reason: `Follow-up scheduling exception: ${error.message}` };
    }
}

/**
 * Updates contact information based on analysis results
 * @param {Object} analysis - Analysis results from transcript
 * @param {Object} contactInfo - Contact information
 * @param {string} conversationId - ElevenLabs conversation ID
 * @returns {Object} Contact update result
 */
async function executePostCallContactUpdate(analysis, contactInfo, conversationId) {
    if (!analysis.needsContactUpdate) {
        return { success: false, reason: 'No contact update needed based on analysis' };
    }

    const contactId = contactInfo.contactId;
    if (!contactId) {
        return { success: false, reason: 'No contact ID available for update' };
    }

    try {
        const updateDetails = analysis.contactUpdateDetails;
        let updatesMade = [];

        // Update address if provided
        if (updateDetails.newAddress && updateDetails.newAddress.trim()) {
            const { updateGHLContactAddress } = await import('./ghl/api.js');
            const addressResult = await updateGHLContactAddress(
                GOHIGHLEVEL_LOCATION_ID, 
                contactId, 
                updateDetails.newAddress.trim()
            );
            
            if (addressResult.success) {
                updatesMade.push(`Address updated to: ${updateDetails.newAddress.trim()}`);
            }
        }

        // Add notes with additional information
        if (updateDetails.additionalNotes || updateDetails.serviceDetails) {
            let noteText = `📞 INFORMAZIONI AGGIORNATE POST-CHIAMATA - ${new Date().toLocaleString('it-IT', { timeZone: ITALIAN_TIMEZONE })}\n\n`;
            
            if (updateDetails.serviceDetails) {
                noteText += `🎯 Dettagli Servizio: ${updateDetails.serviceDetails}\n`;
            }
            
            if (updateDetails.additionalNotes) {
                noteText += `📝 Note Aggiuntive: ${updateDetails.additionalNotes}\n`;
            }
            
            noteText += `🆔 Conversazione: ${conversationId}`;

            const noteResult = await addGHLContactNote(GOHIGHLEVEL_LOCATION_ID, contactId, noteText);
            if (noteResult.success) {
                updatesMade.push('Additional notes added');
            }
        }

        if (updatesMade.length > 0) {
            console.log(`[POST-CALL UPDATE] Updated contact ${contactId} for conversation ${conversationId}: ${updatesMade.join(', ')}`);
            return { 
                success: true, 
                updatesMade,
                details: updateDetails
            };
        } else {
            return { success: false, reason: 'No updates could be performed' };
        }

    } catch (error) {
        console.error(`[POST-CALL UPDATE] Error updating contact for conversation ${conversationId}:`, error);
        return { success: false, reason: `Contact update exception: ${error.message}` };
    }
}

/**
 * Main function to execute post-call analysis and actions
 * @param {Array} transcript - Call transcript from ElevenLabs
 * @param {Object} contactInfo - Contact information from dynamic variables
 * @param {string} conversationId - ElevenLabs conversation ID
 * @param {Object} analysis - Optional pre-computed analysis results
 * @returns {Object} Complete execution results
 */
export async function executePostCallAnalysis(transcript, contactInfo, conversationId, analysis = null) {
    const analysisStartTime = Date.now();
    
    console.log(`[POST-CALL ANALYSIS] Starting analysis for conversation ${conversationId}`);
    
    try {
        // Step 1: Analyze transcript if not provided
        if (!analysis) {
            analysis = await analyzeTranscriptForMissedActions(transcript, contactInfo, conversationId);
        }

        const results = {
            conversationId,
            analysisComplete: true,
            analysisResults: analysis,
            actionsExecuted: {
                appointment: null,
                followUp: null,
                contactUpdate: null
            },
            processingTime: null
        };

        // Step 2: Execute appointment booking if needed
        if (analysis.needsAppointment) {
            console.log(`[POST-CALL ANALYSIS] Executing appointment booking for conversation ${conversationId}`);
            results.actionsExecuted.appointment = await executePostCallAppointmentBooking(analysis, contactInfo, conversationId);
        }

        // Step 3: Execute follow-up scheduling if needed (and no appointment was booked)
        if (analysis.needsFollowUp && (!results.actionsExecuted.appointment || !results.actionsExecuted.appointment.success)) {
            console.log(`[POST-CALL ANALYSIS] Executing follow-up scheduling for conversation ${conversationId}`);
            results.actionsExecuted.followUp = await executePostCallFollowUp(analysis, contactInfo, conversationId);
        }

        // Step 4: Execute contact updates if needed
        if (analysis.needsContactUpdate) {
            console.log(`[POST-CALL ANALYSIS] Executing contact update for conversation ${conversationId}`);
            results.actionsExecuted.contactUpdate = await executePostCallContactUpdate(analysis, contactInfo, conversationId);
        }

        results.processingTime = Date.now() - analysisStartTime;

        // Send summary notification
        const actionsPerformed = [];
        if (results.actionsExecuted.appointment?.success) actionsPerformed.push('Appointment booked');
        if (results.actionsExecuted.followUp?.success) actionsPerformed.push('Follow-up scheduled');
        if (results.actionsExecuted.contactUpdate?.success) actionsPerformed.push('Contact updated');

        if (actionsPerformed.length > 0) {
            await sendPositiveSlackNotification(
                'Post-Call Actions Executed Successfully',
                `Automatically executed ${actionsPerformed.length} missed action(s) after call analysis`,
                {
                    conversationId,
                    actionsPerformed: actionsPerformed.join(', '),
                    contactName: contactInfo.fullName || contactInfo.firstName || 'Unknown',
                    processingTime: results.processingTime,
                    overallAssessment: analysis.overallAssessment
                }
            );
        }

        console.log(`[POST-CALL ANALYSIS] Completed analysis for conversation ${conversationId} in ${results.processingTime}ms`);
        return results;

    } catch (error) {
        const processingTime = Date.now() - analysisStartTime;
        
        console.error(`[POST-CALL ANALYSIS] Critical error processing conversation ${conversationId}:`, error);
        
        await sendNonFatalSlackNotification(
            'Post-Call Analysis Critical Error',
            `Critical error during post-call analysis for conversation ${conversationId}`,
            {
                conversationId,
                error: error.message,
                stack: error.stack,
                processingTime,
                contactInfo
            }
        ).catch(console.error);

        return {
            conversationId,
            analysisComplete: false,
            error: error.message,
            processingTime
        };
    }
}