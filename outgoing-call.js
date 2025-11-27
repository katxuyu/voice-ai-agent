import WebSocket from "ws";
import Twilio from "twilio";
import xmlEscape from "xml-escape";
import fetch from "node-fetch";

import { getCallData, updateCallData } from './callDataDb.js';
import { openDb, closeDb, run, get, getSalesRepsByServiceAndProvince } from './db.js';
import { getValidGoHighlevelToken } from './ghl/tokens.js';
import { fetchGHLCalendarSlots, fetchGHLCalendarSlotsForUsers } from './ghl/api.js';
import { extractProvinceFromAddress } from './utils.js';
import { sendNonFatalSlackNotification, sendNormalSlackNotification, sendSlackNotification } from './slack/notifications.js';
import {
  ITALIAN_TIMEZONE,
  ELEVENLABS_API_KEY,
  getAgentIdForService,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  OUTGOING_ROUTE_PREFIX,
  LOCATION_ID,
  PUBLIC_URL,
  CALENDAR_ID,
  getPhoneNumberForService,
  NO_SALES_REP_WORKFLOW_ID,
  CALL_SCHEDULED_WORKFLOW_ID
} from './config.js';

// ---------------------------------------------------------------------------

export function OutgoingCall(fastify) {
  const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  
  // Clean the route prefix by removing any quotes and setting a default
  let routePrefix = (OUTGOING_ROUTE_PREFIX || '/outgoing').replace(/['"]/g, '');
  
  // Ensure it starts with a forward slash
  if (!routePrefix.startsWith('/') && !routePrefix.startsWith('*')) {
    routePrefix = '/' + routePrefix;
  }
  
  // Remove any empty segments that might cause double slashes
  routePrefix = routePrefix.replace(/\/+/g, '/');

  // ---------------------------------------------------------------------------
  // 1) GET SIGNED URL (ELEVENLABS)
  // ---------------------------------------------------------------------------
  async function getSignedUrl(service) {
    const agentId = getAgentIdForService(service);
    console.log(`[ELEVENLABS] Requesting signed URL from ElevenLabs API for service "${service}" with agent ID: ${agentId}`);
    const elevenlabsUrl = `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`;
    const response = await fetch(elevenlabsUrl, {
      method: "GET",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json"
      }
    });
    if (!response.ok) {
      const errorMessage = `Failed to get signed URL from ElevenLabs API for service "${service}": ${response.status} ${response.statusText}`;
      console.error('[ELEVENLABS] ' + errorMessage);
      throw new Error(errorMessage);
    }
    const data = await response.json();
    return data.signed_url;
  }

  // ---------------------------------------------------------------------------
  // 2) SCHEDULE RETRY (Helper Function)
  // ---------------------------------------------------------------------------
  async function scheduleRetry(callDataForRetryLogic, failedCallSid, options = {}) {
    // options: { reason: string, forceImmediate: boolean }
    const logPrefix = `[RETRY SCHEDULER for ${callDataForRetryLogic.to} (from ${failedCallSid})]`;
    const currentAttemptNumber = callDataForRetryLogic.retry_count !== undefined ? Number(callDataForRetryLogic.retry_count) : 0;
    const MAX_TOTAL_ATTEMPTS = 10;
    
    // Check if this is a retry due to permanent issue (like no sales reps available)
    // In such cases, don't schedule retries as the issue won't be resolved by trying again
    const isPermanentIssue = options.reason === 'no_sales_reps' || 
                            options.reason === 'permanent_failure' ||
                            (callDataForRetryLogic.province === 'unknown' && currentAttemptNumber >= 2);
    
    if (isPermanentIssue) {
      console.log(`${logPrefix} Detected permanent issue (${options.reason}). Not scheduling retry to prevent infinite loop.`);
      try {
        await sendNonFatalSlackNotification(
          'Call Retry Stopped - Permanent Issue',
          `Stopped retrying call for contact ${callDataForRetryLogic.contactId} due to permanent issue: ${options.reason}`,
          {
            contactId: callDataForRetryLogic.contactId,
            phone: callDataForRetryLogic.to,
            service: callDataForRetryLogic.service,
            province: callDataForRetryLogic.province,
            attemptNumber: currentAttemptNumber,
            reason: options.reason,
            failedCallSid: failedCallSid
          }
        );
      } catch (slackError) {
        console.error(`${logPrefix} Failed to send permanent issue notification:`, slackError);
      }
      return;
    }
    const firstAttemptTimestamp = callDataForRetryLogic.first_attempt_timestamp ? new Date(callDataForRetryLogic.first_attempt_timestamp) : new Date();
    if (currentAttemptNumber >= MAX_TOTAL_ATTEMPTS - 1) {
      console.log(`${logPrefix} Max total attempts (${MAX_TOTAL_ATTEMPTS}) reached for contact ${callDataForRetryLogic.contactId} after attempt ${currentAttemptNumber}. No more retries.`);
      return;
    }

    // Custom retry schedule
    const RETRY_SCHEDULE = [
      // Index 0: For first retry (2nd total call), logged as "Attempt 1"
      { type: 'immediate' },
      // Index 1: For second retry (3rd total call), logged as "Attempt 2"
      { type: 'delay', hours: 1 },
      // Index 2: For third retry (4th total call), logged as "Attempt 3"
      { type: 'immediate' },
      // Index 3: For fourth retry (5th total call), logged as "Attempt 4"
      { type: 'next_time', hour: 9 },
      // Index 4: For fifth retry (6th total call), logged as "Attempt 5"
      { type: 'immediate' },
      // Index 5: For sixth retry (7th total call), logged as "Attempt 6"
      { type: 'next_time', hour: 14 },
      // Index 6: For seventh retry (8th total call), logged as "Attempt 7"
      { type: 'immediate' },
      // Index 7: For eighth retry (9th total call), logged as "Attempt 8"
      { type: 'next_time', hour: 19 },
       // Index 8: For ninth retry (10th total call), logged as "Attempt 9"
      { type: 'immediate' },
    ];

    const nextAttemptNumberForDB = currentAttemptNumber + 1;
    const scheduleConfig = RETRY_SCHEDULE[nextAttemptNumberForDB - 1] || { type: 'immediate' };

    let delayMs = 0;
    let scheduled_at_base = new Date();

    if (options.forceImmediate || scheduleConfig.type === 'immediate') {
      delayMs = 0;
      scheduled_at_base = new Date();
      console.log(`${logPrefix} Immediate retry (Attempt ${nextAttemptNumberForDB}).`);
    } else if (scheduleConfig.type === 'delay') {
      delayMs = scheduleConfig.hours * 60 * 60 * 1000;
      scheduled_at_base = new Date(Date.now() + delayMs);
      console.log(`${logPrefix} Delayed retry by ${scheduleConfig.hours} hour(s) (Attempt ${nextAttemptNumberForDB}).`);
    } else if (scheduleConfig.type === 'next_time') {
      // Schedule for the next occurrence of the specified hour (e.g., 9, 14, 19)
      const now = new Date();
      let target = new Date(now);
      target.setHours(scheduleConfig.hour, 0, 0, 0);
      if (now >= target) {
        target.setDate(target.getDate() + 1);
      }
      delayMs = target.getTime() - now.getTime();
      scheduled_at_base = target;
      console.log(`${logPrefix} Scheduled retry for next ${scheduleConfig.hour}:00 (Attempt ${nextAttemptNumberForDB}).`);
    }

    const scheduled_at_iso = scheduled_at_base.toISOString();
    const baseDataForRetry = {
        contactId: callDataForRetryLogic.contactId,
        to: callDataForRetryLogic.to,
        firstName: callDataForRetryLogic.firstName,
        fullName: callDataForRetryLogic.fullName,
        email: callDataForRetryLogic.email,
        availableSlots: callDataForRetryLogic.availableSlots,
        initialSignedUrl: callDataForRetryLogic.signedUrl,
        service: callDataForRetryLogic.service,
    };
    const twimlUrl = `${PUBLIC_URL}${routePrefix}/outbound-call-twiml?firstName=${encodeURIComponent(baseDataForRetry.firstName || '')}&fullName=${encodeURIComponent(baseDataForRetry.fullName || '')}&email=${encodeURIComponent(baseDataForRetry.email || '')}&phone=${encodeURIComponent(baseDataForRetry.to || '')}&contactId=${encodeURIComponent(baseDataForRetry.contactId || '')}&service=${encodeURIComponent(baseDataForRetry.service || '')}`;
    
    // Get the appropriate phone number based on service
    const phoneNumberForService = getPhoneNumberForService(baseDataForRetry.service);
    console.log(`${logPrefix} Using phone number ${phoneNumberForService} for service: ${baseDataForRetry.service}`);
    
    const newCallOptions = {
        from: phoneNumberForService,
        to: baseDataForRetry.to,
        url: twimlUrl,
        timeout: 25,
        timeLimit: 900,
        statusCallback: `${PUBLIC_URL}${routePrefix}/call-status`,
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        machineDetection: "Enable",
        asyncAmd: true,
        asyncAmdStatusCallback: `${PUBLIC_URL}${routePrefix}/call-status`,
    };
    const newCallOptionsJson = JSON.stringify(newCallOptions);
    let dbRetry;
    try {
        dbRetry = await openDb();
        const availableSlotsForRetry = callDataForRetryLogic.availableSlots || 'No availability information found.';
        const result = await run(dbRetry,
            `INSERT INTO call_queue (contact_id, phone_number, first_name, full_name, email, service, province, retry_stage, status, scheduled_at, call_options_json, available_slots_text, initial_signed_url, first_attempt_timestamp)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
            [baseDataForRetry.contactId, baseDataForRetry.to, baseDataForRetry.firstName, baseDataForRetry.fullName, baseDataForRetry.email, baseDataForRetry.service, callDataForRetryLogic.province, nextAttemptNumberForDB, 'pending', scheduled_at_iso, newCallOptionsJson, availableSlotsForRetry, baseDataForRetry.initialSignedUrl, firstAttemptTimestamp.toISOString()]
        );
        console.log(`${logPrefix} Added attempt ${nextAttemptNumberForDB} to DB queue. New Queue ID: ${result.lastID}. Scheduled for: ${scheduled_at_iso}. Available slots: ${availableSlotsForRetry ? availableSlotsForRetry.substring(0, 100) + '...' : 'None'}`);
    } catch (dbError) {
         console.error(`${logPrefix} Error adding attempt ${nextAttemptNumberForDB} to DB queue:`, dbError);
         await sendNonFatalSlackNotification('DB Retry Scheduling Error', dbError.message, { logPrefix, dbError });
    } finally {
        if (dbRetry) await closeDb(dbRetry);
    }
  }

  // ---------------------------------------------------------------------------
  // 3) OUTBOUND CALL ENDPOINT (Initial Call Request)
  // ---------------------------------------------------------------------------
  fastify.post(`${routePrefix}/outbound-call`, async (request, reply) => {   
    // console.log("[OUTBOUND CALL] Received request with body:", JSON.stringify(request.body, null, 2));
    const { phone, contact_id, first_name, full_name, email, Service, full_address, customData } = request.body;
    console.log("[OUTBOUND CALL] Received request with parameters:", phone, contact_id, first_name, full_name, email, Service, full_address);
    
    // Check if this is an abrupt ending retry
    const isAbruptEndingRetry = customData?.isAbruptEndingRetry === true;
    const pastCallSummary = customData?.pastCallSummary || '';
    const originalConversationId = customData?.originalConversationId || '';
    
    if (isAbruptEndingRetry) {
      console.log(`[OUTBOUND CALL] Processing abrupt ending retry for contact ${contact_id}. Original conversation: ${originalConversationId}`);
    }
    
    // Handle different possible field names from GoHighLevel
    const toPhoneValue = phone || request.body.phoneNumber || request.body.phone_number || request.body.Phone;
    const contactId = contact_id || request.body.contactId || request.body.contact_id || request.body.id || request.body.Id;
    const firstName = first_name || request.body.firstName || request.body.first_name || request.body.FirstName;
    const fullName = full_name || request.body.fullName || request.body.full_name || request.body.name || request.body.Name;
    const emailValue = email || request.body.Email;

    // Extract service and address from direct webhook fields
    const service = Service || request.body.Service || request.body.service || "";
    const address = full_address || request.body.full_address || request.body.fullAddress || request.body.address || "";

    // Defensive: Always define province at the top
    let province = null;

    console.log(`[OUTBOUND CALL] Extracted service: "${service}" and address: "${address}" from webhook`);

    // Validation for service
    if (!service) {
      const errorMessage = `Service is missing or empty for contact ${contactId} (${fullName || firstName || 'Unknown'}). Cannot process call without service information.`;
      console.error(`[OUTBOUND CALL] ${errorMessage}`);
      
      try {
        await sendNonFatalSlackNotification(
          'Missing Service - Call Blocked',
          errorMessage,
          {
            contactId,
            fullName: fullName || firstName || 'Unknown',
            phone: toPhoneValue,
            Service,
            full_address,
            customData
          }
        );
      } catch (slackError) {
        console.error('[OUTBOUND CALL] Failed to send missing service notification to Slack:', slackError);
      }
      
      return reply.code(400).send({ error: "A valid 'service' field is required in the webhook payload (e.g. 'Service': 'Infissi')" });
    }
    const ALLOWED_SERVICES = ["Infissi", "Vetrate", "Pergole"];
    if (!ALLOWED_SERVICES.includes(service)) {
      console.error(`[OUTBOUND CALL] Invalid service value: ${service}. Allowed values are: ${ALLOWED_SERVICES.join(", ")}`);
      return reply.code(400).send({ error: `Invalid service value. Allowed values are: ${ALLOWED_SERVICES.join(", ")}` });
    }

    // Validation for address (skip for abrupt ending retries)
    if (!isAbruptEndingRetry && (!address || address.trim() === '')) {
      const errorMessage = `Address is missing or empty for contact ${contactId} (${fullName || firstName || 'Unknown'}). Cannot determine sales rep assignment.`;
      console.error(`[OUTBOUND CALL] ${errorMessage}`);
      
      try {
        await sendNonFatalSlackNotification(
          'Missing Address - Call Blocked',
          errorMessage,
          {
            contactId,
            fullName: fullName || firstName || 'Unknown',
            phone: toPhoneValue,
            service,
            Service,
            full_address,
            customData
          }
        );
      } catch (slackError) {
        console.error('[OUTBOUND CALL] Failed to send missing address notification to Slack:', slackError);
      }
      
      return reply.code(400).send({ error: "Address is required to determine sales rep assignment" });
    }
    
    // For abrupt ending retries, warn if no address but continue processing
    if (isAbruptEndingRetry && (!address || address.trim() === '')) {
      console.warn(`[OUTBOUND CALL] Abrupt ending retry for contact ${contactId} has no address. Will use previous call's sales rep assignment.`);
    }

    console.log("[OUTBOUND CALL] Extracted parameters:", { phone, contact_id, first_name, full_name, email, service, address });

    if (!toPhoneValue || !contactId) {
      console.error("[OUTBOUND CALL] Missing required parameters phone or contactId");
      return reply.code(400).send({ error: "phone and contactId are required" });
    }
    
    let db;
    try {
      console.log(`[ELEVENLABS] Requesting signed URL before call creation for service: ${service}`);
      let signedUrl = await getSignedUrl(service);
      console.log(`[ELEVENLABS] Successfully obtained signed URL before call creation for service: ${service}`);

      // Get the appropriate phone number based on service
      const phoneNumberForService = getPhoneNumberForService(service);
      console.log(`[OUTBOUND CALL] Using phone number ${phoneNumberForService} for service: ${service}`);

      // Build TwiML URL with additional parameters for abrupt ending retry
      let twimlUrl = `${PUBLIC_URL}${routePrefix}/outbound-call-twiml?firstName=${encodeURIComponent(firstName || '')}&fullName=${encodeURIComponent(fullName || '')}&email=${encodeURIComponent(emailValue || '')}&phone=${encodeURIComponent(toPhoneValue)}&contactId=${encodeURIComponent(contactId)}&service=${encodeURIComponent(service)}`;
      
      if (isAbruptEndingRetry) {
        twimlUrl += `&isAbruptEndingRetry=true&pastCallSummary=${encodeURIComponent(pastCallSummary)}&originalConversationId=${encodeURIComponent(originalConversationId)}`;
      }

      const callOptions = {
        from: phoneNumberForService,
        to: toPhoneValue,
        url: twimlUrl,
        timeout: 25,
        timeLimit: 900,
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        machineDetection: "Enable",
        asyncAmd: true,
        asyncAmdStatusCallback: `${PUBLIC_URL}${routePrefix}/call-status`,
      };

      let formattedSlotsString = "Slot availability not checked.";
      let targetSalesReps = [];
      let allSlots = [];
      try {
         const goHighLevelToken = await getValidGoHighlevelToken(LOCATION_ID);
         if (!goHighLevelToken) {
           const errorMessage = `No GoHighLevel tokens found for location ${LOCATION_ID}. Cannot fetch calendar slots or process calls for contact ${contactId} (${fullName || firstName || 'Unknown'}).`;
           console.error(`[OUTBOUND CALL] ${errorMessage}`);
           
           try {
             await sendNonFatalSlackNotification(
               'GoHighLevel Token Missing - Call Blocked',
               errorMessage,
               {
                 contactId,
                 fullName: fullName || firstName || 'Unknown',
                 phone: toPhoneValue,
                 service,
                 locationId: LOCATION_ID,
                 address
               }
             );
           } catch (slackError) {
             console.error('[OUTBOUND CALL] Failed to send GHL token missing notification to Slack:', slackError);
           }
           
           return reply.code(500).send({ error: "GoHighLevel integration not available. Cannot process calls at this time." });
         }
         
         if (goHighLevelToken) {
             const now = new Date();
             const startDate = new Date(now);
             startDate.setDate(startDate.getDate() + 1); // Start from tomorrow
             startDate.setHours(8, 30, 0, 0); // Set start time
             const endDate = new Date(startDate);
             endDate.setDate(startDate.getDate() + 14); // Look for 14 days ahead
             endDate.setHours(21, 30, 0, 0); // Set end time

             if (!CALENDAR_ID) {
                 console.error("[GHL] CALENDAR_ID not set, cannot fetch GHL slots.");
                 formattedSlotsString = "Calendar ID not configured for slot checking.";
             } else {
                 console.log(`[GHL] Fetching slots for calendar ${CALENDAR_ID} from ${startDate.toISOString()} to ${endDate.toISOString()} for service: ${service}`);
                 
                 // Extract province from address (webhook provides full_address field)
                 if (address) {
                     console.log(`[GHL] Extracting province from webhook address: "${address}"`);
                     province = await extractProvinceFromAddress(address);
                     if (province) {
                         console.log(`[GHL] Successfully extracted province "${province}" from webhook address`);
                     } else {
                         console.warn(`[GHL] Could not extract province from webhook address: "${address}"`);
                     }
                 } else if (isAbruptEndingRetry) {
                     console.log(`[GHL] Abrupt ending retry - no address available. Will try to use same sales rep as original call.`);
                 } else {
                     console.warn(`[GHL] No address provided in webhook for contact ${contactId}`);
                 }
                 
                 if (province) {
                     // Step 3: Get sales reps for the province and service from database
                     targetSalesReps = await getSalesRepsByServiceAndProvince(service, province);
                     console.log(`[GHL] Contact from province ${province} for service ${service} - found ${targetSalesReps.length} sales rep(s): ${targetSalesReps.map(rep => `${rep.name} (${rep.ghlUserId})`).join(', ')}`);
                 } else {
                     console.warn(`[GHL] Could not determine province for contact ${contactId}. Address in webhook: ${!!address}`);
                 }
                 
                 // Step 4: Handle different scenarios based on number of candidates
                 if (targetSalesReps.length === 0) {
                     if (isAbruptEndingRetry) {
                         console.log(`[OUTBOUND CALL] Abrupt ending retry for contact ${contactId} - no specific sales reps found, will fetch all available slots for service "${service}"`);
                         // For abrupt ending retries, continue without specific sales rep filtering
                         // We'll fetch slots for all reps for this service
                     } else {
                         console.warn(`[OUTBOUND CALL] No sales representatives found for service "${service}" in province "${province || 'unknown'}" for contact ${contactId} (${fullName || firstName || 'Unknown'}). Adding to GHL workflow.`);
                         
                         // Send normal notification when no sales rep is found
                         try {
                             await sendNormalSlackNotification(
                                 'No Sales Rep Available',
                                 `No sales representatives found for service "${service}" in province "${province || 'unknown'}"`
                             );
                         } catch (slackError) {
                             console.error('[OUTBOUND CALL] Failed to send no sales rep notification to Slack:', slackError);
                             // Send non-fatal notification if the normal notification fails
                             try {
                                 await sendNonFatalSlackNotification(
                                     'Slack Notification Failed',
                                     'Failed to send no sales rep notification',
                                     slackError.message
                                 );
                             } catch (fallbackError) {
                                 console.error('[OUTBOUND CALL] Failed to send fallback notification:', fallbackError);
                             }
                         }
                         
                         // Add contact to GHL workflow when no sales reps are available
                         try {
                             const goHighLevelToken = await getValidGoHighlevelToken(LOCATION_ID);
                             if (goHighLevelToken) {
                                     const workflowResponse = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/workflow/${NO_SALES_REP_WORKFLOW_ID}`, {
                                         method: 'POST',
                                         headers: {
                                             'Authorization': `Bearer ${goHighLevelToken}`,
                                             'Version': '2021-07-28',
                                             'Content-Type': 'application/json'
                                         }
                                     });
                                  if (workflowResponse.ok) {
                                      console.log(`[GHL WORKFLOW] Successfully added contact ${contactId} to workflow ${NO_SALES_REP_WORKFLOW_ID} for no sales reps scenario`);
                                  } else {
                                      const errorMessage = `Failed to add contact ${contactId} to workflow ${NO_SALES_REP_WORKFLOW_ID}: ${workflowResponse.status} ${workflowResponse.statusText}`;
                                      console.error(`[GHL WORKFLOW] ${errorMessage}`);
                                      await sendNonFatalSlackNotification(
                                          'GHL No Sales Rep Workflow HTTP Error',
                                          errorMessage,
                                          {
                                              contactId,
                                              workflowId: NO_SALES_REP_WORKFLOW_ID,
                                              status: workflowResponse.status,
                                              statusText: workflowResponse.statusText
                                          }
                                      ).catch(console.error);
                                  }
                             }
                         } catch (workflowError) {
                             console.error(`[GHL WORKFLOW] Error adding contact ${contactId} to workflow:`, workflowError);
                             await sendNonFatalSlackNotification(
                                 'GHL Workflow Error',
                                 `Failed to add contact ${contactId} to workflow when no sales reps available`,
                                 workflowError.message
                             ).catch(console.error);
                         }
                         
                         return reply.code(400).send({ error: "No sales representatives available for this service and location" });
                     }
                 }
                 
                 const targetUserIds = targetSalesReps.map(rep => rep.ghlUserId);
                 
                 if (targetUserIds.length === 0 && isAbruptEndingRetry) {
                     // Step 5a: Abrupt ending retry with no specific sales reps - fetch all slots for the service
                     console.log(`[GHL] Abrupt ending retry - fetching all available slots for service: ${service}`);
                     const rawSlots = await fetchGHLCalendarSlots(LOCATION_ID, CALENDAR_ID, startDate.toISOString(), endDate.toISOString(), service);
                     
                     if (rawSlots && Array.isArray(rawSlots)) {
                         allSlots = rawSlots;
                     }
                 } else if (targetUserIds.length === 1) {
                     // Step 5b: Single candidate - use fetchGHLCalendarSlots with userId
                     console.log(`[GHL] Fetching slots for single sales rep: ${targetSalesReps[0].name} (${targetUserIds[0]})`);
                     const rawSlots = await fetchGHLCalendarSlots(LOCATION_ID, CALENDAR_ID, startDate.toISOString(), endDate.toISOString(), service, targetUserIds[0]);
                     
                     if (rawSlots && Array.isArray(rawSlots)) {
                         allSlots = rawSlots;
                     }
                 } else if (targetUserIds.length > 1) {
                     // Step 5c: Multiple candidates - use fetchGHLCalendarSlotsForUsers
                     console.log(`[GHL] Fetching slots for multiple sales reps: ${targetUserIds.join(', ')}`);
                     allSlots = await fetchGHLCalendarSlotsForUsers(LOCATION_ID, CALENDAR_ID, startDate.toISOString(), endDate.toISOString(), targetUserIds);
                 }
                 
                 if (allSlots && Array.isArray(allSlots) && allSlots.length > 0) {
                     const groupedSlots = {};
                     let totalSlotsCount = 0;
                     const uniqueUserIds = new Set();
                     
                     allSlots.forEach(slotObj => {
                         try {
                             const isoString = slotObj.datetime || slotObj;
                             const userId = slotObj.userId || null;
                             const dateObj = new Date(isoString);
                             
                             if (!isNaN(dateObj.getTime())) {
                                 totalSlotsCount++;
                                 if (userId) uniqueUserIds.add(userId);
                                 
                                 const italianDateKey = dateObj.toLocaleDateString('en-CA', { timeZone: ITALIAN_TIMEZONE }); // YYYY-MM-DD for sorting
                                 const timePart = dateObj.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: ITALIAN_TIMEZONE });
                                 
                                 if (!groupedSlots[italianDateKey]) {
                                     const datePartStr = dateObj.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: ITALIAN_TIMEZONE }).replace(/\//g, '-');
                                     let weekdayStr = dateObj.toLocaleDateString('it-IT', { weekday: 'short', timeZone: ITALIAN_TIMEZONE });
                                     weekdayStr = weekdayStr.charAt(0).toUpperCase() + weekdayStr.slice(1).replace('.', '');
                                     groupedSlots[italianDateKey] = { header: `${weekdayStr} ${datePartStr}`, times: [], userIds: [] };
                                 }
                                 
                                 // Store both time and userId information
                                 const timeWithUser = userId ? `${timePart}|${userId}` : timePart;
                                 groupedSlots[italianDateKey].times.push(timeWithUser);
                                 if (userId && !groupedSlots[italianDateKey].userIds.includes(userId)) {
                                     groupedSlots[italianDateKey].userIds.push(userId);
                                 }
                             } else { 
                                console.warn(`[GHL] Invalid date string encountered in GHL slots: ${isoString}`); 
                            }
                         } catch (parseError) { 
                            console.warn(`[GHL] Error parsing date string from GHL slots: ${slotObj}`, parseError); 
                        }
                     });
                     
                     const formattedLines = [];
                     const sortedDateKeys = Object.keys(groupedSlots).sort();
                     
                     // Strategy 1: Single sales rep - omit userId completely (most common case)
                     if (uniqueUserIds.size === 1) {
                         const singleUserId = Array.from(uniqueUserIds)[0];
                         console.log(`[GHL] Optimizing slots format for single sales rep: ${singleUserId}`);
                         
                         for (const dateKey of sortedDateKeys) {
                             const group = groupedSlots[dateKey];
                             // Extract just the times, removing the userId suffix
                             const timesOnly = group.times.map(timeWithUser => timeWithUser.split('|')[0]);
                             timesOnly.sort((a, b) => a.localeCompare(b));
                             formattedLines.push(`${group.header}: ${timesOnly.join(', ')}`);
                         }
                         
                         // Add a single line at the end indicating which sales rep handles all slots
                         formattedLines.push(`\\nSales Rep: ${singleUserId}`);
                         
                     } else if (uniqueUserIds.size <= 3) {
                         // Strategy 2: Few sales reps (2-3) - use abbreviated userIds
                         console.log(`[GHL] Optimizing slots format for ${uniqueUserIds.size} sales reps`);
                         
                         // Create a mapping of userIds to short codes (A, B, C)
                         const userIdMap = {};
                         const codes = ['A', 'B', 'C'];
                         Array.from(uniqueUserIds).forEach((userId, index) => {
                             userIdMap[userId] = codes[index];
                         });
                         
                         for (const dateKey of sortedDateKeys) {
                             const group = groupedSlots[dateKey];
                             // Convert to short codes
                             const timesWithCodes = group.times.map(timeWithUser => {
                                 const [time, userId] = timeWithUser.split('|');
                                 return userId ? `${time}(${userIdMap[userId]})` : time;
                             });
                             timesWithCodes.sort((a, b) => {
                                 const timeA = a.split('(')[0];
                                 const timeB = b.split('(')[0];
                                 return timeA.localeCompare(timeB);
                             });
                             formattedLines.push(`${group.header}: ${timesWithCodes.join(', ')}`);
                         }
                         
                         // Add legend with userIds
                         formattedLines.push('\\nSales Reps:');
                         Array.from(uniqueUserIds).forEach((userId, index) => {
                             formattedLines.push(`${codes[index]} = ${userId}`);
                         });
                         
                     } else {
                         // Strategy 3: Many sales reps (4+) - group by rep first, then by date
                         console.log(`[GHL] Using rep-grouped format for ${uniqueUserIds.size} sales reps`);
                         
                         const repGroups = {};
                         
                         // Group slots by sales rep first
                         allSlots.forEach(slotObj => {
                             const isoString = slotObj.datetime || slotObj;
                             const userId = slotObj.userId || 'unknown';
                             const dateObj = new Date(isoString);
                             
                             if (!isNaN(dateObj.getTime())) {
                                 if (!repGroups[userId]) {
                                     repGroups[userId] = { slots: {} };
                                 }
                                 
                                 const italianDateKey = dateObj.toLocaleDateString('en-CA', { timeZone: ITALIAN_TIMEZONE });
                                 const timePart = dateObj.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: ITALIAN_TIMEZONE });
                                 
                                 if (!repGroups[userId].slots[italianDateKey]) {
                                     const datePartStr = dateObj.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: ITALIAN_TIMEZONE }).replace(/\//g, '-');
                                     let weekdayStr = dateObj.toLocaleDateString('it-IT', { weekday: 'short', timeZone: ITALIAN_TIMEZONE });
                                     weekdayStr = weekdayStr.charAt(0).toUpperCase() + weekdayStr.slice(1).replace('.', '');
                                     repGroups[userId].slots[italianDateKey] = { header: `${weekdayStr} ${datePartStr}`, times: [] };
                                 }
                                 
                                 repGroups[userId].slots[italianDateKey].times.push(timePart);
                             }
                         });
                         
                         // Format output grouped by rep
                         Object.entries(repGroups).forEach(([userId, repData]) => {
                             formattedLines.push(`\\n${userId}:`);
                             const sortedDates = Object.keys(repData.slots).sort();
                             sortedDates.forEach(dateKey => {
                                 const dayData = repData.slots[dateKey];
                                 dayData.times.sort((a, b) => a.localeCompare(b));
                                 formattedLines.push(`  ${dayData.header}: ${dayData.times.join(', ')}`);
                             });
                         });
                     }
                     
                     if (totalSlotsCount > 0) { 
                        formattedSlotsString = formattedLines.join('\\n'); 
                        console.log(`[GHL] Formatted sales rep-filtered GHL slots (${totalSlotsCount} total, ${uniqueUserIds.size} reps):\n${formattedSlotsString}`);
                    } else { 
                        formattedSlotsString = "Nessuno slot disponibile nell'intervallo richiesto (dopo elaborazione)."; 
                        console.log("[GHL] No valid slots found after processing the received array.");
                    }
                 } else if (allSlots === null) {
                    formattedSlotsString = "Errore nel recupero degli slot GHL."; 
                    console.error("[GHL] Slot fetching returned null, indicating a fetch error.");
                } else {
                    formattedSlotsString = "Nessuno slot disponibile nell'intervallo richiesto (vuoto o non valido)."; 
                    console.log("[GHL] No slots returned (array is empty) or data is not an array.");
                }
             }
         }
      } catch (slotsError) {
        console.error("[GHL] Error during slot fetching:", slotsError);
        formattedSlotsString = "Errore durante il controllo degli slot.";
        
        // CRITICAL CHECK: If we have sales reps but slot fetching threw an error, send fatal notification and stop
        if (targetSalesReps.length > 0 && !isAbruptEndingRetry) {
          const errorTitle = '🚨 FATAL: GHL Calendar API Exception with Sales Reps Available';
          const errorMessage = `GHL Calendar API threw an exception while fetching slots for available sales representatives in ${province || 'unknown province'} for service "${service}". This prevents calls from being made despite having ${targetSalesReps.length} sales rep(s) available.`;
          
          console.error(`[OUTBOUND CALL] ${errorTitle}: ${errorMessage}`);
          
          try {
            await sendSlackNotification(new Error(errorMessage + `\n\nContact Details:\n- Contact ID: ${contactId}\n- Name: ${fullName || firstName || 'Unknown'}\n- Phone: ${toPhoneValue}\n- Service: ${service}\n- Province: ${province || 'unknown'}\n- Sales Reps: ${targetSalesReps.map(rep => `${rep.name} (${rep.ghlUserId})`).join(', ')}\n- Original Error: ${slotsError.message}\n- Stack: ${slotsError.stack}`));
          } catch (slackError) {
            console.error('[OUTBOUND CALL] Failed to send fatal slot exception notification to Slack:', slackError);
          }
          
          return reply.code(500).send({ 
            error: "Calendar API exception: Cannot fetch available slots for sales representatives",
            critical: true,
            salesRepsAvailable: targetSalesReps.length,
            province: province || 'unknown',
            service: service,
            originalError: slotsError.message
          });
        }
      }

      // CRITICAL CHECK: If we have sales reps but no slots or API errors, send fatal notification and stop
      if (targetSalesReps.length > 0 && !isAbruptEndingRetry) {
        const hasSlotError = formattedSlotsString.includes("Errore") || allSlots === null;
        const hasNoSlots = formattedSlotsString.includes("Nessuno slot disponibile") || 
                          (Array.isArray(allSlots) && allSlots.length === 0);
        
        if (hasSlotError || hasNoSlots) {
          const errorTitle = hasSlotError ? 
            '🚨 FATAL: GHL Calendar API Error with Sales Reps Available' : 
            '🚨 FATAL: No Calendar Slots Available with Sales Reps';
          
          const errorMessage = hasSlotError ?
            `GHL Calendar API failed to fetch slots for available sales representatives in ${province || 'unknown province'} for service "${service}". This prevents calls from being made despite having ${targetSalesReps.length} sales rep(s) available.` :
            `No calendar slots available for ${targetSalesReps.length} sales representative(s) in ${province || 'unknown province'} for service "${service}". This prevents calls from being made despite having sales reps available.`;
          
          console.error(`[OUTBOUND CALL] ${errorTitle}: ${errorMessage}`);
          
          try {
            await sendSlackNotification(new Error(errorMessage + `\n\nContact Details:\n- Contact ID: ${contactId}\n- Name: ${fullName || firstName || 'Unknown'}\n- Phone: ${toPhoneValue}\n- Service: ${service}\n- Province: ${province || 'unknown'}\n- Sales Reps: ${targetSalesReps.map(rep => `${rep.name} (${rep.ghlUserId})`).join(', ')}\n- Slots Response: ${formattedSlotsString}`));
          } catch (slackError) {
            console.error('[OUTBOUND CALL] Failed to send fatal slot error notification to Slack:', slackError);
          }
          
          return reply.code(500).send({ 
            error: hasSlotError ? 
              "Calendar API error: Cannot fetch available slots for sales representatives" : 
              "No calendar slots available for assigned sales representatives",
            critical: true,
            salesRepsAvailable: targetSalesReps.length,
            province: province || 'unknown',
            service: service
          });
        }
      }

      db = await openDb();
      const scheduled_at_iso = new Date().toISOString(); // Initial call is scheduled for immediate processing by the queue
      const callOptionsJson = JSON.stringify(callOptions);
      const firstAttemptTimestamp = new Date(); // This is the very first attempt for this contactId in this sequence

      const result = await run(db,
         `INSERT INTO call_queue (contact_id, phone_number, first_name, full_name, email, service, province, retry_stage, status, scheduled_at, call_options_json, available_slots_text, initial_signed_url, first_attempt_timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
         [contactId, toPhoneValue, firstName, fullName, emailValue, service, province,
          0, // Initial attempt is retry_stage 0
          'pending', scheduled_at_iso, callOptionsJson, formattedSlotsString, signedUrl, firstAttemptTimestamp.toISOString()]
      );
      
      console.log(`[OUTBOUND CALL] Initial call for ${toPhoneValue} (Attempt 0 / DB Stage 0) added to DB queue with ID: ${result.lastID}. First attempt timestamp: ${firstAttemptTimestamp.toISOString()}. Service: ${service}`);

      // Add contact to call scheduled workflow
      try {
        const goHighLevelToken = await getValidGoHighlevelToken(LOCATION_ID);
        if (goHighLevelToken) {
          const workflowResponse = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/workflow/${CALL_SCHEDULED_WORKFLOW_ID}`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${goHighLevelToken}`,
              'Version': '2021-07-28',
              'Content-Type': 'application/json'
            }
          });
          if (workflowResponse.ok) {
            console.log(`[GHL WORKFLOW] Successfully added contact ${contactId} to call scheduled workflow ${CALL_SCHEDULED_WORKFLOW_ID}`);
          } else {
            const errorMessage = `Failed to add contact ${contactId} to call scheduled workflow ${CALL_SCHEDULED_WORKFLOW_ID}: ${workflowResponse.status} ${workflowResponse.statusText}`;
            console.error(`[GHL WORKFLOW] ${errorMessage}`);
            await sendNonFatalSlackNotification(
              'GHL Call Scheduled Workflow HTTP Error',
              errorMessage,
              {
                contactId,
                workflowId: CALL_SCHEDULED_WORKFLOW_ID,
                status: workflowResponse.status,
                statusText: workflowResponse.statusText
              }
            ).catch(console.error);
          }
        }
      } catch (workflowError) {
        console.error(`[GHL WORKFLOW] Error adding contact ${contactId} to call scheduled workflow:`, workflowError);
        await sendNonFatalSlackNotification(
          'GHL Call Scheduled Workflow Error',
          `Failed to add contact ${contactId} to call scheduled workflow`,
          workflowError.message
        ).catch(console.error);
      }

      return reply.code(202).send({ // 202 Accepted: Request accepted, processing will occur later by queue-processor
         success: true,
         message: "Call successfully queued for processing.",
         queueId: result.lastID
      });

    } catch (error) {
      console.error('Error in initial outbound call queuing:', error);
      return reply.code(500).send({ success: false, error: error.message });
    } finally {
       if (db) await closeDb(db);
    }
  });

  // ---------------------------------------------------------------------------
  // 4) CALL STATUS HANDLER (NEW - for Twilio callbacks)
  // ---------------------------------------------------------------------------
  fastify.post(`${routePrefix}/call-status`, async (request, reply) => {
    const { CallSid, CallStatus, AnsweredBy, To } = request.body;
    let call = await getCallData(CallSid);
    if (!call) {
        console.warn(`[CALL STATUS ${CallSid}] Original call data not found in 'calls' table. This might be an unsolicited status or an issue with getCallData. Body:`, request.body);
        await sendNonFatalSlackNotification('Call Status: Call Data Not Found', `CallSid: ${CallSid}`, request.body);
        return reply.code(200).send('OK. No call data found in calls table.'); 
    }

    if (call.retry_scheduled) {
        console.log(`[CALL STATUS ${CallSid}] A retry has already been scheduled for this call. Ignoring status: ${CallStatus}.`);
        return reply.code(200).send('OK. Retry already handled.');
    }

    const currentAnsweredBy = call.answeredBy;
    const machineDetectionStatuses = ['machine_start', 'fax', 'machine_beep', 'machine_end_silence', 'machine_end_other', 'machine_end_beep'];
    const isMachineDetected = (AnsweredBy && machineDetectionStatuses.includes(String(AnsweredBy).toLowerCase())) ||
                              (currentAnsweredBy && machineDetectionStatuses.includes(String(currentAnsweredBy).toLowerCase()));
    console.log(`[CALL STATUS ${CallSid}] Status Update: ${CallStatus}`, {
        answeredByRaw: AnsweredBy,
        answeredByStored: currentAnsweredBy,
        toFromTwilio: To,
        toFromDB: call.to,
        contactId: call.contactId
    });
    if (AnsweredBy && AnsweredBy !== currentAnsweredBy) {
        try {
            await updateCallData(CallSid, { answeredBy: AnsweredBy });
            call.answeredBy = AnsweredBy;
            console.log(`[CALL STATUS ${CallSid}] Updated AnsweredBy to '${AnsweredBy}' in DB`);
        } catch (error) {
            console.error(`[CALL STATUS ${CallSid}] Failed to update AnsweredBy in DB:`, error);
        }
    }
    // If machine detected and not terminal, end call and schedule retry
    if (isMachineDetected && !["completed", "canceled", "failed"].includes(CallStatus)) {
        console.log(`[${CallSid}] Machine detected during ongoing call. Attempting to end call and schedule retry.`);
        try {
            await updateCallData(CallSid, { retry_scheduled: 1 }); // Set flag before any async operation
            const currentCallState = await twilioClient.calls(CallSid).fetch();
            if (!['completed', 'canceled', 'failed'].includes(currentCallState.status)) {
                await twilioClient.calls(CallSid).update({ status: "completed" });
                console.log(`[${CallSid}] Successfully sent command to end call.`);
            } else {
                console.log(`[${CallSid}] Call already terminal (${currentCallState.status}) before command sent.`);
            }
        } catch (error) {
            console.error(`[${CallSid}] Failed to end call after early machine detection:`, error);
        }
        await scheduleRetry(call, CallSid, { reason: 'machine_detected' });
        console.log(`[${CallSid}] Scheduled retry after machine detection.`);
        return reply.code(200).send('OK. Machine detected, call ended, retry scheduled.');
    }
    // Retryable failure (machine on completed/canceled, no-answer, busy, failed)
    const isRetryableFailure =
        ((["completed", "canceled"].includes(CallStatus) && isMachineDetected) ||
        CallStatus === "no-answer" ||
        CallStatus === "busy" ||
        CallStatus === "failed");
    if (isRetryableFailure) {
        await updateCallData(CallSid, { retry_scheduled: 1 }); // Set flag
        await scheduleRetry(call, CallSid, { reason: 'retryable_failure' });
        console.log(`[CALL STATUS ${CallSid}] Scheduled retry for retryable failure.`);
        return reply.code(200).send('OK. Retryable failure, retry scheduled.');
    }
    if (CallStatus === "completed" && !isMachineDetected) {
        console.log(`[CALL STATUS ${CallSid}] Call completed by human. No retry needed.`);
        return reply.code(200).send('OK. Human answered, no retry.');
    }
    if (["completed", "canceled"].includes(CallStatus) && !isMachineDetected) {
        console.log(`[CALL STATUS ${CallSid}] Call ended (Status: ${CallStatus}). No retry/human action.`);
        return reply.code(200).send('OK. Call ended, no retry.');
    }
    return reply.code(200).send('OK');
  });

  // ---------------------------------------------------------------------------
  // 5) OUTBOUND-CALL-TWIML ENDPOINT
  // ---------------------------------------------------------------------------
  fastify.all(`${routePrefix}/outbound-call-twiml`, async (request, reply) => {
    console.log("[TWIML] Received request with query parameters:", request.query);
    const firstName = xmlEscape(request.query.firstName || "");
    const fullName = xmlEscape(request.query.fullName || "");
    const email = xmlEscape(request.query.email || "");
    const phone = xmlEscape(request.query.phone || "");
    const contactId = xmlEscape(request.query.contactId || "");
    const service = xmlEscape(request.query.service || "");
    const isAbruptEndingRetry = xmlEscape(request.query.isAbruptEndingRetry || "");
    const pastCallSummary = xmlEscape(request.query.pastCallSummary || "");
    const originalConversationId = xmlEscape(request.query.originalConversationId || "");
    
    console.log("[TWIML] Processed parameters after XML escape:", { firstName, fullName, email, phone, contactId, service, isAbruptEndingRetry: !!isAbruptEndingRetry });

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${PUBLIC_URL.replace(/^https?:\/\//, '')}${routePrefix}/outbound-media-stream">
            <Parameter name="firstName" value="${firstName}" />
            <Parameter name="fullName" value="${fullName}" />
            <Parameter name="email" value="${email}" />
            <Parameter name="phone" value="${phone}" />
            <Parameter name="contactId" value="${contactId}" />
            <Parameter name="callSid" value="${xmlEscape(request.query.CallSid || request.body.CallSid || '')}" />
            <Parameter name="service" value="${service}" />
            <Parameter name="isAbruptEndingRetry" value="${isAbruptEndingRetry}" />
            <Parameter name="pastCallSummary" value="${pastCallSummary}" />
            <Parameter name="originalConversationId" value="${originalConversationId}" />
          </Stream>
        </Connect>
      </Response>`;
    
    console.log("[TWIML] TwiML response being sent.");
    reply.type("text/xml").send(twimlResponse.trim());
  });

  // ---------------------------------------------------------------------------
  // 6) OUTBOUND-MEDIA-STREAM (WebSocket) ENDPOINT
  // ---------------------------------------------------------------------------
  fastify.register(async (fastifyInstance) => {
    fastifyInstance.get(`${routePrefix}/outbound-media-stream`, { websocket: true }, (ws, request) => {
      console.info("[Server] Twilio connected to outbound media stream");
      const connectionState = { streamSid: null, callSid: null, customParameters: {}, elevenLabsWs: null };

      const setupElevenLabs = async (availableSlots) => {
        try {
          const callData = await getCallData(connectionState.callSid);
          const service = connectionState.customParameters.service || "";
          let signedUrl = callData?.signedUrl || await getSignedUrl(service);
          
          // Get province from call data if available (do this outside the callback)
          let provinceForAI = null;
          try {
            if (callData && callData.province) {
              provinceForAI = callData.province;
              console.log(`[ElevenLabs] Retrieved province "${provinceForAI}" from call data for AI context`);
            }
          } catch (error) {
            console.warn(`[ElevenLabs] Could not retrieve province from call data:`, error);
          }
          
          connectionState.elevenLabsWs = new WebSocket(signedUrl);
          connectionState.elevenLabsWs.on("open", () => {
            console.log("[ElevenLabs] Connected to Conversational AI");
            
            const serviceParam = connectionState.customParameters.service || "";
            let businessName = "";
            if (serviceParam === "Infissi") {
              businessName = "Ristrutturiamolo";
            } else if (serviceParam === "Vetrate" || serviceParam === "Pergole") {
              businessName = "UNICOVETRATE";
            }

            const initialConfig = {
              type: "conversation_initiation_client_data",
              dynamic_variables: {
                firstName: connectionState.customParameters.firstName || "",
                fullName: connectionState.customParameters.fullName || "",
                email: connectionState.customParameters.email || "",
                phone: connectionState.customParameters.phone || "",
                contactId: connectionState.customParameters.contactId || "",
                nowDate: new Date().toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(/[/]/g, '-'),
                availableSlots: availableSlots, // Directly use the availableSlots string
                service: serviceParam,
                businessName: businessName,
                province: provinceForAI || "" // Add province to dynamic variables
              }
            };
            
            // Handle abrupt ending retry - add pastCallSummary and override first message
            const isAbruptRetry = connectionState.customParameters.isAbruptEndingRetry === 'true';
            if (isAbruptRetry) {
              console.log(`[ElevenLabs] Configuring abrupt ending retry for ${connectionState.customParameters.firstName}`);
              initialConfig.dynamic_variables.pastCallSummary = connectionState.customParameters.pastCallSummary || '';
              initialConfig.dynamic_variables.originalConversationId = connectionState.customParameters.originalConversationId || '';
              
              // Override the first message for abrupt ending retry
              initialConfig.first_message_override = `Pronto ${connectionState.customParameters.firstName || 'cliente'}? Era caduta la linea, mi senti?`;
              
              console.log(`[ElevenLabs] Added pastCallSummary (${initialConfig.dynamic_variables.pastCallSummary.length} chars) and custom first message for abrupt retry`);
            }
            console.log("[DEBUG] Initial ElevenLabs config:", initialConfig);
            
            // Add connection quality check
            if (connectionState.elevenLabsWs.readyState === WebSocket.OPEN) {
              connectionState.elevenLabsWs.send(JSON.stringify(initialConfig));
              console.log("[ElevenLabs] Sent initial config");
            } else {
              console.warn("[ElevenLabs] WebSocket not ready when trying to send initial config");
            }
          });

          connectionState.elevenLabsWs.on("message", async (data) => {
            try {
              const message = JSON.parse(data);
              const timestamp = new Date().toISOString();
              switch (message.type) {
                case "conversation_initiation_metadata":
                  const conversationId = message.conversation_initiation_metadata_event?.conversation_id;
                  if (connectionState.callSid) {
                    try {
                      await updateCallData(connectionState.callSid, { conversationId }); 
                      console.log(`[ElevenLabs] Saved conversationId to SQLite for callSid: ${connectionState.callSid}`);
                    } catch (sqliteError) {
                      console.error(`[ElevenLabs] Failed to save conversationId to SQLite:`, sqliteError);
                    }
                  } else {
                    console.warn(`[ElevenLabs] No callSid available to save conversationId`);
                  }
                  break;
                case "audio":
                  let payload;
                  if (message.audio?.chunk) {
                    payload = message.audio.chunk;
                  } else if (message.audio_event?.audio_base_64) {
                    payload = message.audio_event.audio_base_64;
                  } else {
                    console.warn("[ElevenLabs] No audio payload found in the message.");
                  }
                  if (connectionState.streamSid && payload) {
                    const audioData = {
                      event: "media",
                      streamSid: connectionState.streamSid,
                      media: { payload },
                    };
                    try {
                      // Add small delay to prevent audio rushing
                      if (ws.readyState === ws.OPEN) {
                        ws.send(JSON.stringify(audioData));
                      }
                    } catch (sendError) {
                      console.error(`[ElevenLabs] Failed to send audio data to Twilio:`, sendError);
                    }
                  } else {
                    console.warn(`[ElevenLabs] streamSid or payload is missing. streamSid: ${connectionState.streamSid}, payload available: ${!!payload}`);
                  }
                  break;
                case "interruption":
                  console.log(`[ElevenLabs] Received interruption event`);
                  if (connectionState.streamSid) {
                    try {
                      ws.send(JSON.stringify({ event: "clear", streamSid: connectionState.streamSid }));
                      console.log(`[ElevenLabs] Sent clear event to Twilio`);
                    } catch (sendError) {
                      console.error(`[ElevenLabs] Failed to send clear event to Twilio:`, sendError);
                    }
                  }
                  break;
                case "ping":
                  if (message.ping_event?.event_id) {
                    if (connectionState.elevenLabsWs.readyState === WebSocket.OPEN) {
                      try {
                        connectionState.elevenLabsWs.send(JSON.stringify({
                          type: "pong",
                          event_id: message.ping_event.event_id
                        }));
                      } catch (sendError) {
                        console.error(`[ElevenLabs] Failed to send pong response:`, sendError);
                      }
                    } else {
                      console.warn(`[ElevenLabs] WebSocket not open (readyState: ${connectionState.elevenLabsWs.readyState}), cannot send pong response.`);
                    }
                  }
                  break;
                case "function_call":
                  console.log(`[ElevenLabs] Function call received:`, JSON.stringify(message, null, 2));
                  const functionCall = message.function_call_event;
                  if (functionCall?.function_name === "book_appointment") {
                    try {
                      const args = functionCall.arguments;
                      console.log(`[ElevenLabs] book_appointment called with args:`, args);
                      
                      // Extract userId from appointmentDate if present
                      let userId = null;
                      let cleanAppointmentDate = args.appointmentDate;
                      
                      // Check if the appointment date contains userId information
                      // Format examples:
                      // - "01-03-2025 14:00" (Strategy 1: single rep, no userId in date)
                      // - "01-03-2025 14:00(A)" (Strategy 2: abbreviated userId)
                      // - "01-03-2025 14:00" (Strategy 3: rep-grouped, no userId in individual times)
                      
                      if (args.appointmentDate && typeof args.appointmentDate === 'string') {
                        // Strategy 2: Check for abbreviated format like "14:00(A)"
                        const abbreviatedMatch = args.appointmentDate.match(/^(.+?)(\([A-C]\))$/);
                        if (abbreviatedMatch) {
                          cleanAppointmentDate = abbreviatedMatch[1]; // Remove the (A) part
                          const abbreviation = abbreviatedMatch[2].replace(/[()]/g, ''); // Extract A, B, or C
                          
                          // Get the legend from available slots to map abbreviation to userId
                          try {
                            const callData = await getCallData(connectionState.callSid);
                            if (callData?.availableSlots) {
                              const slotsText = callData.availableSlots;
                              const legendMatch = slotsText.match(new RegExp(`${abbreviation} = ([a-zA-Z0-9]+)`));
                              if (legendMatch) {
                                userId = legendMatch[1];
                                console.log(`[ElevenLabs] Extracted userId ${userId} for abbreviation ${abbreviation}`);
                              }
                            }
                          } catch (error) {
                            console.warn(`[ElevenLabs] Could not extract userId from abbreviated format:`, error);
                          }
                        }
                        
                        // Strategy 1: For single rep, we need to get the userId from the slots data
                        if (!userId) {
                          try {
                            const callData = await getCallData(connectionState.callSid);
                            if (callData?.availableSlots) {
                              const slotsText = callData.availableSlots;
                              
                              // Check if it's Strategy 1 format (ends with "Sales Rep: userId")
                              const singleRepMatch = slotsText.match(/Sales Rep: ([a-zA-Z0-9]+)$/);
                              if (singleRepMatch) {
                                userId = singleRepMatch[1];
                                console.log(`[ElevenLabs] Extracted userId ${userId} for single sales rep strategy`);
                              }
                              
                              // Strategy 3: Check if the appointment is within a rep-grouped section
                              const timeOnly = cleanAppointmentDate.replace(/^\d{2}-\d{2}-\d{4} /, '');
                              const repSectionRegex = new RegExp(`\\n([a-zA-Z0-9]+):\\s*\\n[\\s]*[A-Za-z]{3} \\d{2}-\\d{2}-\\d{4}: [^\\\\n]*${timeOnly.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\\\n]*`);
                              const repSectionMatch = slotsText.match(repSectionRegex);
                              if (repSectionMatch) {
                                userId = repSectionMatch[1];
                                console.log(`[ElevenLabs] Extracted userId ${userId} for rep-grouped strategy`);
                              }
                            }
                          } catch (error) {
                            console.warn(`[ElevenLabs] Could not extract userId from single rep or rep-grouped format:`, error);
                          }
                        }
                      }
                      
                      // Prepare booking request payload
                      const bookingPayload = {
                        appointmentDate: cleanAppointmentDate,
                        contactId: args.contactId
                      };
                      
                      // Include userId if we found one
                      if (userId) {
                        bookingPayload.userId = userId;
                        console.log(`[ElevenLabs] Including userId ${userId} in booking request`);
                      } else {
                        console.log(`[ElevenLabs] No userId extracted, booking without specific sales rep assignment`);
                      }
                      
                      // Call the booking endpoint
                      const bookingResponse = await fetch(`${PUBLIC_URL}/star-italia/bookAppointment`, {
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(bookingPayload)
                      });
                      
                      const bookingResult = await bookingResponse.json();
                      console.log(`[ElevenLabs] Booking result:`, bookingResult);
                      
                      // Send function response back to ElevenLabs
                      const functionResponse = {
                        type: "function_call_response",
                        function_call_response: {
                          function_name: "book_appointment",
                          response: bookingResult.status === "success" ? 
                            "Appointment successfully booked!" : 
                            `Booking failed: ${bookingResult.message}`
                        }
                      };
                      
                      if (connectionState.elevenLabsWs.readyState === WebSocket.OPEN) {
                        connectionState.elevenLabsWs.send(JSON.stringify(functionResponse));
                        console.log(`[ElevenLabs] Sent function response:`, functionResponse);
                      }
                    } catch (error) {
                      console.error(`[ElevenLabs] Error processing book_appointment:`, error);
                      
                      // Send error response
                      const errorResponse = {
                        type: "function_call_response",
                        function_call_response: {
                          function_name: "book_appointment",
                          response: "Technical error occurred during booking. Please try again later."
                        }
                      };
                      
                      if (connectionState.elevenLabsWs.readyState === WebSocket.OPEN) {
                        connectionState.elevenLabsWs.send(JSON.stringify(errorResponse));
                      }
                    }
                  }
                  break;
                default:
                  console.log(`[${timestamp}] [ElevenLabs] Received unhandled message type: ${message.type}`, JSON.stringify(message, null, 2));
              }
            } catch (error) {
              console.error(`[${new Date().toISOString()}] [ElevenLabs] Error processing message:`, error);
              console.log(`[ElevenLabs] Raw message data:`, data);
            }
          });

          connectionState.elevenLabsWs.on("error", (error) => {
            console.error("[ElevenLabs] WebSocket error:", error);
            console.log("[ElevenLabs] WebSocket state at error:", connectionState.elevenLabsWs.readyState);
            console.log("[ElevenLabs] Error details:", {
              message: error.message,
              type: error.type,
              code: error.code,
              target: error.target?.url
            });
            
            // Try to reconnect if connection lost
            if (error.code === 'ECONNRESET' || error.code === 'ENOTFOUND') {
              console.log("[ElevenLabs] Connection lost, will attempt reconnection on next audio event");
            }
          });

          connectionState.elevenLabsWs.on("close", async (code, reason) => {
            const reasonText = reason.toString();
            console.log(`[ElevenLabs] WebSocket closed with code ${code}: ${reasonText}`);
            
            // Send non-fatal notification for all error codes except 1005 (No Status Received)
            if (code && code !== 1005 && code !== 1000) {
              const callSidShort = connectionState.callSid || 'Unknown';
              const messageText = `[ElevenLabs ${callSidShort}] WebSocket closed unexpectedly with code ${code}. Reason: ${reasonText}`;
              
              try {
                await sendNonFatalSlackNotification(
                  'ElevenLabs WebSocket Error',
                  messageText,
                  {
                    twilioCallSid: connectionState.callSid,
                    streamSid: connectionState.streamSid,
                    closeCode: code,
                    closeReason: reasonText,
                    wsState: connectionState.elevenLabsWs?.readyState || 'unknown',
                    contactId: connectionState.customParameters?.contactId,
                    service: connectionState.customParameters?.service
                  }
                );
              } catch (slackError) {
                console.error('[ElevenLabs] Failed to send WebSocket close notification to Slack:', slackError);
              }
            }
          });
        } catch (error) {
          console.error("[ElevenLabs] Setup error:", error);
        }
      };

      ws.on("message", async (message) => {
        try {
          const msg = JSON.parse(message);
          switch (msg.event) {
            case "start":
              ({ streamSid: connectionState.streamSid, callSid: connectionState.callSid, customParameters: connectionState.customParameters } = msg.start);
              console.log(`[Twilio] Stream started - StreamSid: ${connectionState.streamSid}, CallSid: ${connectionState.callSid}`);
              
              let availableSlotsString = "No availability information found."; // Default message
              if (connectionState.callSid) {
                  try {
                      const callDataFromDb = await getCallData(connectionState.callSid);
                      if (callDataFromDb && callDataFromDb.availableSlots) {
                          availableSlotsString = callDataFromDb.availableSlots;
                          console.log(new Date().toISOString(), `[SQLite] Retrieved available slots for CallSid ${connectionState.callSid}: ${availableSlotsString.substring(0, 100)}...`);
                      } else {
                          console.warn(new Date().toISOString(), `[SQLite] availableSlots not found in DB for CallSid ${connectionState.callSid}.`);
                      }
                  } catch (dbError) {
                      console.error(new Date().toISOString(), `[SQLite] Error fetching call data for slots for CallSid ${connectionState.callSid}:`, dbError);
                  }
              } else {
                  console.error(new Date().toISOString(), "[Twilio] CallSid missing in start event payload, cannot fetch slots from DB.");
              }
              await setupElevenLabs(availableSlotsString);
              break;
            case "media":
              if (connectionState.elevenLabsWs?.readyState === WebSocket.OPEN) {
                connectionState.elevenLabsWs.send(JSON.stringify({
                  type: "user_audio",
                  user_audio_chunk: msg.media.payload
                }));
              }
              break;
            case "stop":
              console.log(`[Twilio] Stream ${connectionState.streamSid} ended`);
              connectionState.elevenLabsWs?.readyState === WebSocket.OPEN && connectionState.elevenLabsWs.close();
              break;
            default:
              console.log(`[Twilio] Unhandled event: ${msg.event}`);
          }
        } catch (error) {
          console.error("[Twilio] Error processing message:", error);
        }
      });

      ws.on("close", () => {
        console.log("[Twilio] Client disconnected");
        if (connectionState.elevenLabsWs?.readyState === WebSocket.OPEN) {
          connectionState.elevenLabsWs.close();
        }
      });

      ws.on("error", (error) => {
        console.error("[WebSocket] Error:", error);
      });
    });
  });
}