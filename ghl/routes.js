// Enhanced with comprehensive Slack notifications for debugging and monitoring:
// - Configuration errors (missing CLIENT_ID, REDIRECT_URI, CALENDAR_ID)
// - Parameter validation failures
// - Province detection issues
// - Sales rep availability problems
// - Date parsing errors
// - Operating hours violations
// - GHL API errors and token issues
// - Database pre-check errors
// - Critical booking failures

import { saveGoHighlevelTokens, getValidGoHighlevelToken } from './tokens.js';
import { fetchGHLCalendarSlots, bookGHLAppointment, bookGHLAppointmentWithUser, getGHLContactDetails, updateGHLContactAddress, fetchGHLCalendarSlotsForUsers } from './api.js';
import { italianLocalToUTC, getNextValidWorkday, isOperatingHours, extractUserIdFromSlotsText } from '../utils.js';
import { openDb, closeDb, run, get as getDbRecord, getSalesRepsByServiceAndProvince } from '../db.js'; // Renamed import
import { getCallData } from '../callDataDb.js';
import { sendSlackNotification, sendNonFatalSlackNotification } from '../slack/notifications.js';
import { 
    GOHIGHLEVEL_CLIENT_ID, 
    GOHIGHLEVEL_CLIENT_SECRET, 
    GOHIGHLEVEL_REDIRECT_URI,
    GOHIGHLEVEL_AUTH_URL,
    GOHIGHLEVEL_TOKEN_URL,
    GOHIGHLEVEL_API_SCOPES,
    GOHIGHLEVEL_CALENDAR_ID,
    GOHIGHLEVEL_LOCATION_ID,
    ITALIAN_TIMEZONE,
} from '../config.js';

export function registerGhlRoutes(fastify) {
    // GoHighLevel Auth Route
    fastify.get(`/gohighlevel/auth`, async (request, reply) => {
        // Redirects the user to GoHighLevel for authorization
        // Check for Client ID and Redirect URI from env
        if (!GOHIGHLEVEL_CLIENT_ID || !GOHIGHLEVEL_REDIRECT_URI) {
            console.error(new Date().toISOString(), "[GOHIGHLEVEL] Auth endpoint configuration incomplete (CLIENT_ID, REDIRECT_URI).");
            sendNonFatalSlackNotification(
                'GHL Auth Configuration Error',
                'GoHighLevel auth endpoint configuration is incomplete - missing CLIENT_ID or REDIRECT_URI',
                {
                    hasClientId: !!GOHIGHLEVEL_CLIENT_ID,
                    hasRedirectUri: !!GOHIGHLEVEL_REDIRECT_URI,
                    endpoint: '/gohighlevel/auth'
                }
            ).catch(console.error);
            return reply.code(500).send({ status: "error", message: "OAuth not configured" });
        }
    
        // Create params *without* scope first, URLSearchParams will handle their encoding.
        const params = new URLSearchParams({
            response_type: "code",
            redirect_uri: GOHIGHLEVEL_REDIRECT_URI, // From config
            client_id: GOHIGHLEVEL_CLIENT_ID // From config
            // Scope will be added manually to ensure %20 for spaces
        });
    
        // Manually encode scope with %20 for spaces, ensuring each part is URI encoded.
        // This is to ensure GoHighLevel receives %20 instead of + for spaces in the scope list.
        const scopeEncodedFinal = GOHIGHLEVEL_API_SCOPES.split(' ').map(s => encodeURIComponent(s)).join('%20');
    
        // Use URL object for robust construction
        const authUrl = new URL(GOHIGHLEVEL_AUTH_URL);
        // Append other params and the correctly %20 encoded scope
        authUrl.search = `${params.toString()}&scope=${scopeEncodedFinal}`;
    
        console.log(new Date().toISOString(), `[GOHIGHLEVEL] Redirecting user to GoHighLevel authorization URL: ${authUrl.toString()}`);
    
        // Return the URL for manual use or redirect
        // return reply.redirect(authUrl.toString()); // Use this for actual redirection
        return reply.send({ authorization_url: authUrl.toString() });
    });

    // GoHighLevel Callback Route
    fastify.get(`/hl/callback`, async (request, reply) => {
        // Handles the callback from GoHighLevel after authorization, stores tokens
        const authCode = request.query.code;
        const locationIdFromCallback = request.query.location_id;

        if (!authCode) {
            console.warn(new Date().toISOString(), "[GOHIGHLEVEL] Callback received without authorization code.");
            return reply.code(400).send({ status: "error", message: "OAuth failed: No code provided" });
        }
        if (!locationIdFromCallback) {
            console.warn(new Date().toISOString(), "[GOHIGHLEVEL] Callback received without location_id query parameter. Will rely on token exchange response.");
        } else {
            console.log(new Date().toISOString(), `[GOHIGHLEVEL] Callback received for location_id: ${locationIdFromCallback}`);
        }


        // Check for required environment variables (Client ID, Secret, Redirect URI still from env)
        if (!GOHIGHLEVEL_CLIENT_ID || !GOHIGHLEVEL_CLIENT_SECRET ||
            !GOHIGHLEVEL_REDIRECT_URI) {
            console.error(new Date().toISOString(), "[GOHIGHLEVEL] Callback handler configuration incomplete (CLIENT_ID, CLIENT_SECRET, REDIRECT_URI).");
            sendSlackNotification(":alert: GHL Callback Error: Missing GOHIGHLEVEL_CLIENT_ID, GOHIGHLEVEL_CLIENT_SECRET, or GOHIGHLEVEL_REDIRECT_URI environment variables.").catch(console.error);
            return reply.code(500).send({ status: "error", message: "OAuth configuration incomplete" });
        }

        const tokenPayload = new URLSearchParams({
            client_id: GOHIGHLEVEL_CLIENT_ID, // From config
            client_secret: GOHIGHLEVEL_CLIENT_SECRET, // From config
            grant_type: "authorization_code",
            code: authCode,
            redirect_uri: GOHIGHLEVEL_REDIRECT_URI, // From config
            user_type: "Location" // Or "Company"
        });

        console.log(new Date().toISOString(), "[GOHIGHLEVEL] Exchanging authorization code for GoHighLevel tokens...");
        try {
            const response = await fetch(GOHIGHLEVEL_TOKEN_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: tokenPayload
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error(new Date().toISOString(), `Failed to obtain GoHighLevel tokens. Status: ${response.status}, Details: ${errorText}`);
                sendSlackNotification(`:alert: GHL Callback Error: Failed to exchange code for tokens. Status: ${response.status}. Check logs for details.`).catch(console.error);
                return reply.code(response.status).send({ status: "error", message: `Failed to obtain tokens: ${errorText}` });
            }

            const responseText = await response.text();
            console.log(new Date().toISOString(), `Token Exchange Response Status: ${response.status}`);
            // Avoid logging sensitive tokens in production if possible

            // Now parse the successful response
            try {
                const tokenData = JSON.parse(responseText);
                const accessToken = tokenData.access_token;
                const refreshToken = tokenData.refresh_token; 
                const expiresIn = tokenData.expires_in; // Seconds
                const locationIdFromResponse = tokenData.locationId; // Get locationId from the response

                // Ensure we have a location ID from either the callback or the response
                const locationId = locationIdFromResponse || locationIdFromCallback;
                if (!locationId) {
                    console.error(new Date().toISOString(), `Failed to obtain locationId from either callback query or token response. Cannot save tokens. Body: ${responseText}`);
                    sendSlackNotification(`:alert: GHL Callback Error: Failed to obtain locationId from OAuth callback or token response. Cannot save tokens.`).catch(console.error);
                    return reply.code(500).send({ status: "error", message: "Token exchange failed: Missing locationId" });
                }

                if (!accessToken || !refreshToken) {
                    console.error(new Date().toISOString(), `[${locationId}] Failed to obtain tokens: access_token or refresh_token missing in response. Body: ${responseText}`);
                    sendSlackNotification(`:alert: GHL Callback Error [Location: ${locationId}]: Missing access_token or refresh_token in response from GHL.`).catch(console.error);
                    return reply.code(500).send({ status: "error", message: "Token exchange failed: Missing tokens in response" });
                }

                console.log(new Date().toISOString(), `[${locationId}] Token exchange successful.`);

                // Calculate expiry time (UTC)
                let expiresAt = null;
                if (expiresIn) {
                    expiresAt = new Date(Date.now() + (parseInt(expiresIn) - 60) * 1000); // 60s buffer
                }

                // Save tokens to database USING THE LOCATION ID
                const saveSuccess = await saveGoHighlevelTokens(locationId, accessToken, refreshToken, expiresAt);
                if (saveSuccess) {
                    console.log(new Date().toISOString(), `[${locationId}] Successfully obtained and saved GoHighLevel tokens. Access token expires around: ${expiresAt ? expiresAt.toISOString() : 'N/A'}`);
                    // Maybe redirect to a success page or provide clearer feedback
                    return reply.send({ status: "success", message: `GoHighLevel OAuth successful for location ${locationId} and tokens stored.` });
                } else {
                    console.error(new Date().toISOString(), `[${locationId}] Failed to save GoHighLevel tokens to database after successful exchange.`);
                    sendSlackNotification(`:alert: GHL Callback Error [Location: ${locationId}]: Failed to save GHL tokens to database after successful exchange.`).catch(console.error);
                    return reply.code(500).send({ status: "error", message: `Token exchange successful for location ${locationId} but failed to save tokens` });
                }
            } catch (parseError) {
                console.error(new Date().toISOString(), `Error parsing GHL token response JSON: ${parseError.message}. Response Text: ${responseText}`);
                sendSlackNotification(`:alert: GHL Callback Error: Error parsing token response from GHL. Check logs.`).catch(console.error);
                return reply.code(500).send({ status: "error", message: "Failed to parse token response from GoHighLevel." });
            }
        } catch (e) {
            console.error(new Date().toISOString(), `Unexpected error during GoHighLevel token exchange: ${e.message}`, e);
            sendSlackNotification(`:alert: GHL Callback Exception: Unexpected error during token exchange. Error: ${e.message}. Check logs.`).catch(console.error);
            return reply.code(500).send({ status: "error", message: `Internal server error during token exchange: ${e.message}` });
        }
    });

    // New endpoint to get available GHL calendar slots for outbound calls
    fastify.get(`/availableSlotsOutbound`, async (request, reply) => {
        const { Timeframe, AppointmentDate, address, service, province } = request.query;
        const calendarId = GOHIGHLEVEL_CALENDAR_ID;
        const location_id = GOHIGHLEVEL_LOCATION_ID;

        console.log(`[AvailableSlotsOutbound - ${location_id}] Received request. Query params: Timeframe='${Timeframe}', AppointmentDate='${AppointmentDate}', Address='${address}', Service='${service}', Province='${province}'`);

        if (!Timeframe || !AppointmentDate || !service) {
            console.warn(`[AvailableSlotsOutbound - ${location_id}] Missing required query parameters.`);
            sendNonFatalSlackNotification(
                'AvailableSlotsOutbound - Missing Parameters',
                `Missing required query parameters in /availableSlotsOutbound endpoint`,
                {
                    location_id,
                    provided: { Timeframe, AppointmentDate, service, address, province },
                    missing: [
                        !Timeframe && 'Timeframe',
                        !AppointmentDate && 'AppointmentDate', 
                        !service && 'service'
                    ].filter(Boolean)
                }
            ).catch(console.error);
            return reply.code(400).send({
                status: "error",
                message: "Missing required query parameters. Please provide: Timeframe, AppointmentDate, and service."
            });
        }

        // Use province parameter if provided, otherwise try to extract from address
        let targetProvince = province;
        if (!targetProvince && address) {
            const extractProvince = (address) => {
                if (!address) return null;
                const match = address.match(/\(([A-Z]{2})\)/);
                return match ? match[1] : null;
            };
            targetProvince = extractProvince(address);
        }

        if (!targetProvince) {
            console.warn(`[AvailableSlotsOutbound - ${location_id}] Could not determine province. Province param: '${province}', Address: '${address}'`);
            sendNonFatalSlackNotification(
                'AvailableSlotsOutbound - Province Detection Failed',
                `Could not determine province from parameters in /availableSlotsOutbound`,
                {
                    location_id,
                    provinceParam: province,
                    address: address,
                    service: service,
                    troubleshooting: 'Check if address contains province in format (XX) or province parameter is provided'
                }
            ).catch(console.error);
            return reply.code(400).send({ status: "error", message: "Province is required. Please provide either 'province' parameter or address in format with (XX)." });
        }
        console.log(`[AvailableSlotsOutbound - ${location_id}] Using province '${targetProvince}' for service '${service}'`);

        const reps = await getSalesRepsByServiceAndProvince(service, targetProvince);
        if (!reps || reps.length === 0) {
            const message = `No sales reps found for service '${service}' in province '${targetProvince}'.`;
            console.warn(`[AvailableSlotsOutbound - ${location_id}] ${message}`);
            sendNonFatalSlackNotification(
                'AvailableSlotsOutbound - No Sales Reps',
                `No sales representatives found for requested service and province`,
                {
                    location_id,
                    service: service,
                    province: targetProvince,
                    address: address,
                    troubleshooting: 'Check sales rep database configuration and ensure reps are assigned to this service/province combination'
                }
            ).catch(console.error);
            return reply.code(404).send({ status: "error", message });
        }

        const userIds = reps.map(rep => rep.ghlUserId);
        console.log(`[AvailableSlotsOutbound - ${location_id}] Found ${reps.length} sales reps for '${service}' in '${targetProvince}': ${userIds.join(', ')}`);

        const timeFormatValid = /^\d{2}:\d{2}$/.test(Timeframe);
        if (!timeFormatValid) {
            console.warn(`[AvailableSlotsOutbound - ${location_id}] Invalid Timeframe format: '${Timeframe}'`);
            return reply.code(400).send({ status: "error", message: "Invalid Timeframe format. Expected HH:mm." });
        }

        let formattedAppointmentDate;
        if (/^\d{4}-\d{2}-\d{2}$/.test(AppointmentDate)) {
            const parts = AppointmentDate.split('-');
            formattedAppointmentDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
        } else if (/^\d{2}-\d{2}-\d{4}$/.test(AppointmentDate)) {
            formattedAppointmentDate = AppointmentDate;
        } else {
            console.warn(`[AvailableSlotsOutbound - ${location_id}] Invalid AppointmentDate format: '${AppointmentDate}'. Expected DD-MM-YYYY or YYYY-MM-DD.`);
            return reply.code(400).send({ status: "error", message: "Invalid AppointmentDate format. Expected DD-MM-YYYY or YYYY-MM-DD." });
        }

        let initialStartDate;
        try {
            initialStartDate = italianLocalToUTC(formattedAppointmentDate, Timeframe);
            if (isNaN(initialStartDate.getTime())) {
                throw new Error("Parsed date is invalid.");
            }
        } catch (e) {
            console.error(`[AvailableSlotsOutbound - ${location_id}] Error parsing AppointmentDate '${AppointmentDate}' and Timeframe '${Timeframe}': ${e.message}`, e);
            sendNonFatalSlackNotification(
                'AvailableSlotsOutbound - Date Parsing Error',
                `Failed to parse AppointmentDate and Timeframe in /availableSlotsOutbound`,
                {
                    location_id,
                    appointmentDate: AppointmentDate,
                    timeframe: Timeframe,
                    formattedDate: formattedAppointmentDate,
                    error: e.message,
                    stack: e.stack
                }
            ).catch(console.error);
            return reply.code(400).send({ status: "error", message: `Invalid AppointmentDate or Timeframe. Details: ${e.message}` });
        }

        const tryFetchSlotsForDate = async (currentStartDateUTC) => {
            const startDateForFetch = new Date(currentStartDateUTC.getTime());
            const endDateForFetch = new Date(startDateForFetch.getTime() + 3 * 60 * 60 * 1000);
            const startDateISO = startDateForFetch.toISOString();
            const endDateISO = endDateForFetch.toISOString();

            console.log(`[AvailableSlotsOutbound - ${location_id}] Calling fetchGHLCalendarSlotsForUsers for calendar '${calendarId}' with ${userIds.length} users. Window: ${startDateISO} to ${endDateISO}.`);
            const slots = await fetchGHLCalendarSlotsForUsers(location_id, calendarId, startDateISO, endDateISO, userIds);
            
            if (slots === null) {
                 console.error(`[AvailableSlotsOutbound - ${location_id}] fetchGHLCalendarSlotsForUsers returned null, indicating an API or token error.`);
                 sendNonFatalSlackNotification(
                    'GHL API Error - AvailableSlotsOutbound (Users)',
                    `Failed to fetch slots for users for calendar ${calendarId}.`,
                    { calendarId, location_id, userIds, startDateISO, endDateISO }
                 ).catch(console.error);
            }
            
            console.log(`[AvailableSlotsOutbound - ${location_id}] fetchGHLCalendarSlotsForUsers returned:`, slots ? `${slots.length} slots` : 'null');
            return slots;
        };

        // Make a single request for 7 days of slots starting from the initial date
        const sevenDaysLater = new Date(initialStartDate);
        sevenDaysLater.setUTCDate(initialStartDate.getUTCDate() + 7);
        
        const startDateISO = initialStartDate.toISOString();
        const endDateISO = sevenDaysLater.toISOString();
        
        console.log(`[AvailableSlotsOutbound - ${location_id}] Fetching slots for 7-day period from ${startDateISO} to ${endDateISO}`);
        console.log(`[AvailableSlotsOutbound - ${location_id}] Calling fetchGHLCalendarSlotsForUsers for calendar '${calendarId}' with ${userIds.length} users. Window: ${startDateISO} to ${endDateISO}.`);
        
        const allSlots = await fetchGHLCalendarSlotsForUsers(location_id, calendarId, startDateISO, endDateISO, userIds);
        
        if (allSlots === null) {
            console.error(`[AvailableSlotsOutbound - ${location_id}] fetchGHLCalendarSlotsForUsers returned null, indicating an API or token error.`);
            sendNonFatalSlackNotification(
                'GHL API Error - AvailableSlotsOutbound (7-day search)',
                `Failed to fetch slots for users for calendar ${calendarId} during 7-day search.`,
                { calendarId, location_id, userIds, startDateISO, endDateISO }
            ).catch(console.error);
            return reply.code(500).send({ status: "error", message: "Failed to retrieve slot data from provider." });
        }
        
        console.log(`[AvailableSlotsOutbound - ${location_id}] fetchGHLCalendarSlotsForUsers returned: ${allSlots ? allSlots.length : 0} slots for 7-day period`);
        
        if (!allSlots || allSlots.length === 0) {
            console.log(`[AvailableSlotsOutbound - ${location_id}] No slots found in the 7-day period.`);
            return reply.code(404).send({ status: "error", message: "No available slots were found for the requested address and time within the next 7 days." });
        }

        // Since we have slots available, return them even if they don't match the exact requested timeframe
        // This provides flexibility for appointment booking
        console.log(`[AvailableSlotsOutbound - ${location_id}] Found ${allSlots.length} total slots across 7 days. Returning first available slots.`);
        
        // Sort slots by date to return the earliest available
        const sortedSlots = allSlots.sort((a, b) => {
            const dateA = new Date(a.datetime);
            const dateB = new Date(b.datetime);
            return dateA.getTime() - dateB.getTime();
        });
        
        // Return the first few slots (limit to 3 as per the original API behavior)
        const slotsToReturn = sortedSlots.slice(0, 15);
        
        console.log(`[AvailableSlotsOutbound - ${location_id}] SUCCESS: Returning ${slotsToReturn.length} earliest available slots from the 7-day period.`);
        slotsToReturn.forEach((slot, index) => {
            console.log(`[AvailableSlotsOutbound - ${location_id}] Slot ${index + 1}: ${slot.datetime} (userId: ${slot.userId})`);
        });
        
        return reply.code(200).send({ status: "success", slots: slotsToReturn });

        console.log(`[AvailableSlotsOutbound - ${location_id}] FINAL: No available slots found in the requested timeframe across the 7-day period.`);
        return reply.code(404).send({ status: "error", message: "No available slots were found for the requested address and time within the next 7 days." });
    });

    // New endpoint for inbound calls to get slots for the next 7 days, formatted
    fastify.get(`/availableSlotsInbound`, async (request, reply) => {
        const calendarId = GOHIGHLEVEL_CALENDAR_ID; // Hardcoded as in the other endpoint
        const location_id = GOHIGHLEVEL_LOCATION_ID;  // Hardcoded as in the other endpoint

        if (!isOperatingHours()) {
            console.warn(`[AvailableSlotsInbound - ${location_id}] Attempt to fetch slots outside operating hours (8-20 Italy time).`);
            sendNonFatalSlackNotification(
                'AvailableSlotsInbound - Outside Operating Hours',
                `Attempt to fetch slots outside operating hours (8-20 Italy time)`,
                {
                    location_id,
                    currentTime: new Date().toISOString(),
                    italianTime: new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' }),
                    endpoint: '/availableSlotsInbound'
                }
            ).catch(console.error);
            return reply.code(403).send({
                status: "error",
                message: "Slot checking is only allowed between 8 AM and 8 PM Italy time."
            });
        }

        console.log(`[AvailableSlotsInbound - ${location_id}] Received request for 7-day formatted slots.`);

        try {
            const today = new Date();
            today.setUTCHours(0, 0, 0, 0); // Start of today UTC

            const endDate = new Date(today);
            endDate.setUTCDate(today.getUTCDate() + 7); // End of 7 days from today UTC

            const startDateISO = today.toISOString();
            const endDateISO = endDate.toISOString();

            console.log(`[AvailableSlotsInbound - ${location_id}] Fetching GHL slots for calendar '${calendarId}' from ${startDateISO} to ${endDateISO}`);
            const rawSlots = await fetchGHLCalendarSlots(location_id, calendarId, startDateISO, endDateISO);

            if (rawSlots === null) {
                console.error(`[AvailableSlotsInbound - ${location_id}] Failed to fetch GHL slots (API/token error).`);
                sendNonFatalSlackNotification(
                    'AvailableSlotsInbound - GHL API Error',
                    `Failed to fetch GHL slots in /availableSlotsInbound - API or token error`,
                    {
                        location_id,
                        calendarId,
                        startDateISO,
                        endDateISO,
                        endpoint: '/availableSlotsInbound',
                        troubleshooting: 'Check GHL token validity and API connectivity'
                    }
                ).catch(console.error);
                return reply.code(500).send({ status: "error", message: "Failed to retrieve slot data from provider." });
            }

            if (!Array.isArray(rawSlots) || rawSlots.length === 0) {
                console.log(`[AvailableSlotsInbound - ${location_id}] No raw slots found for the 7-day period.`);
                return reply.code(200).send({ status: "success", count: 0, formattedString: "Nessuno slot disponibile nell'intervallo richiesto." });
            }
            
            console.log(`[AvailableSlotsInbound - ${location_id}] Received ${rawSlots.length} raw slots from GHL. Formatting...`);

            // Define the filter window: today UTC and next day UTC
            const filterStartDateUTC = new Date(today); // today at 00:00:00 UTC
            const filterEndDateUTC = new Date(today);
            filterEndDateUTC.setUTCDate(today.getUTCDate() + 2); // End of the second day (today + 2 days, exclusive of the third day)

            const filteredSlots = rawSlots.filter(isoString => {
                try {
                    const slotDateUTC = new Date(isoString);
                    if (isNaN(slotDateUTC.getTime())) return false; // Invalid date string
                    return slotDateUTC >= filterStartDateUTC && slotDateUTC < filterEndDateUTC;
                } catch (e) {
                    console.warn(`[AvailableSlotsInbound - ${location_id}] Error parsing slot string '${isoString}' during 2-day filtering. Excluding. Error: ${e.message}`);
                    return false;
                }
            });

            console.log(`[AvailableSlotsInbound - ${location_id}] Filtered down to ${filteredSlots.length} slots within the first 2 days.`);

            // Formatting logic (adapted from inbound-call.js's original fetchGoHighlevelFreeSlots)
            const groupedSlots = {};
            let totalSlotsCount = 0;

            filteredSlots.forEach(isoString => {
                try {
                    const dateObj = new Date(isoString);
                    if (!isNaN(dateObj.getTime())) {
                        totalSlotsCount++;
                        const italianDateKey = dateObj.toLocaleDateString('en-CA', { timeZone: ITALIAN_TIMEZONE }); // YYYY-MM-DD for grouping
                        const timePart = dateObj.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: ITALIAN_TIMEZONE }); // HH:mm

                        if (!groupedSlots[italianDateKey]) {
                             const datePartStr = dateObj.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: ITALIAN_TIMEZONE }).replace(/\//g, '-');
                             let weekdayStr = dateObj.toLocaleDateString('it-IT', { weekday: 'short', timeZone: ITALIAN_TIMEZONE });
                             weekdayStr = weekdayStr.charAt(0).toUpperCase() + weekdayStr.slice(1).replace('.', '');
                             groupedSlots[italianDateKey] = {
                                 header: `${weekdayStr} ${datePartStr}`,
                                 times: []
                             };
                        }
                        groupedSlots[italianDateKey].times.push(timePart);
                    } else {
                        console.warn(`[AvailableSlotsInbound - ${location_id}] Invalid date string encountered during formatting: ${isoString}`);
                    }
                } catch (parseError) {
                    console.warn(`[AvailableSlotsInbound - ${location_id}] Error parsing date string during formatting: ${isoString}`, parseError);
                }
            });

            const formattedLines = [];
            const sortedDateKeys = Object.keys(groupedSlots).sort();

            for (const dateKey of sortedDateKeys) {
                const group = groupedSlots[dateKey];
                group.times.sort((a, b) => a.localeCompare(b)); // Sort times as strings HH:mm
                formattedLines.push(`${group.header}: ${group.times.join(', ')}`);
            }
            const finalFormattedString = formattedLines.join('\\n'); // Literal \n for the string

            if (totalSlotsCount > 0) {
                 console.log(`[AvailableSlotsInbound - ${location_id}] Formatted grouped slots string (${totalSlotsCount} total slots, Italian Time)`);
            } else {
                console.log(`[AvailableSlotsInbound - ${location_id}] No valid slots found to format after processing raw slots.`);
            }
            
            return reply.code(200).send({
                status: "success",
                count: totalSlotsCount,
                formattedString: totalSlotsCount > 0 ? finalFormattedString : "Nessuno slot disponibile nell'intervallo richiesto."
            });

        } catch (error) {
            console.error(`[AvailableSlotsInbound - ${location_id}] Unexpected error: ${error.message}`, error);
            sendNonFatalSlackNotification(
                'AvailableSlotsInbound - Unexpected Error',
                `Unexpected error in /availableSlotsInbound endpoint`,
                {
                    location_id,
                    calendarId,
                    error: error.message,
                    stack: error.stack,
                    endpoint: '/availableSlotsInbound'
                }
            ).catch(console.error);
            return reply.code(500).send({ status: "error", message: "An unexpected error occurred while fetching formatted slots." });
        }
    });

    // Endpoint to book an appointment
    fastify.post(`/bookAppointment`, async (request, reply) => {
        const { appointmentDate, contactId, address, userId } = request.body;
        const calendarId = GOHIGHLEVEL_CALENDAR_ID;
        const location_id = GOHIGHLEVEL_LOCATION_ID;

        console.log(`[BookAppointment - ${location_id}] Received request. DateTimeString: '${appointmentDate}', ContactID: '${contactId}'`);

        if (!appointmentDate || !contactId) {
            console.warn(`[BookAppointment - ${location_id}] Missing required body parameters.`);
            sendNonFatalSlackNotification(
                'BookAppointment - Missing Parameters',
                `Missing required body parameters in /bookAppointment endpoint`,
                {
                    location_id,
                    provided: { appointmentDate, contactId, address, userId },
                    missing: [
                        !appointmentDate && 'appointmentDate',
                        !contactId && 'contactId'
                    ].filter(Boolean),
                    endpoint: '/bookAppointment'
                }
            ).catch(console.error);
            return reply.code(400).send({
                status: "error",
                message: "Missing required body parameters. Please provide: appointmentDate and contactId."
            });
        }

        const dateTimeParts = appointmentDate.split(' ');
        if (dateTimeParts.length !== 2) {
            console.warn(`[BookAppointment - ${location_id}] Invalid appointmentDate format: '${appointmentDate}'. Expected 'DD-MM-YYYY HH:mm' or 'YYYY-MM-DD HH:mm'.`);
            return reply.code(400).send({ status: "error", message: "Invalid appointmentDate format. Expected 'DD-MM-YYYY HH:mm' or 'YYYY-MM-DD HH:mm'." });
        }
        
        let dateStrInput = dateTimeParts[0];
        const timeStr = dateTimeParts[1];
        let formattedDateStr; // This will hold DD-MM-YYYY

        // Validate time format first
        if (!/^\d{2}:\d{2}$/.test(timeStr)) {
            console.warn(`[BookAppointment - ${location_id}] Invalid time format in appointmentDate: Time='${timeStr}'. Expected 'HH:mm'.`);
            return reply.code(400).send({ status: "error", message: "Invalid time format within appointmentDate. Expected 'HH:mm'." });
        }

        // Check for YYYY-MM-DD format
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateStrInput)) {
            console.log(`[BookAppointment - ${location_id}] Detected YYYY-MM-DD format: '${dateStrInput}'. Converting to DD-MM-YYYY.`);
            const parts = dateStrInput.split('-');
            formattedDateStr = `${parts[2]}-${parts[1]}-${parts[0]}`; // Convert YYYY-MM-DD to DD-MM-YYYY
        // Check for DD-MM-YYYY format
        } else if (/^\d{2}-\d{2}-\d{4}$/.test(dateStrInput)) {
            formattedDateStr = dateStrInput;
        } else {
            console.warn(`[BookAppointment - ${location_id}] Invalid date format in appointmentDate: Date='${dateStrInput}'. Expected 'DD-MM-YYYY' or 'YYYY-MM-DD'.`);
            return reply.code(400).send({ status: "error", message: "Invalid date format. Expected 'DD-MM-YYYY' or 'YYYY-MM-DD'." });
        }

        console.log(`[BookAppointment - ${location_id}] Using date for UTC conversion (DD-MM-YYYY): '${formattedDateStr}', Time: '${timeStr}'.`);

        let targetSlotStartUTC;
        try {
            console.log(`[BookAppointment - ${location_id}] Attempting to parse Italian local time for booking: Date='${formattedDateStr}', Time='${timeStr}' to UTC.`);
            targetSlotStartUTC = italianLocalToUTC(formattedDateStr, timeStr);
            if (isNaN(targetSlotStartUTC.getTime())) {
                throw new Error("Parsed targetSlotStartUTC is Invalid Date.");
            }
            console.log(`[BookAppointment - ${location_id}] Successfully parsed target booking time to UTC Date: ${targetSlotStartUTC.toISOString()}`);
        } catch (e) {
            console.error(`[BookAppointment - ${location_id}] Error parsing appointmentDate '${appointmentDate}' (formatted as '${formattedDateStr} ${timeStr}') into UTC Date: ${e.message}`, e);
            return reply.code(400).send({ status: "error", message: `Invalid appointmentDate. Could not parse to UTC. Details: ${e.message}` });
        }

        try {
            console.log(`[BookAppointment - ${location_id}] Attempting to book GHL appointment for ContactID: '${contactId}' at ${targetSlotStartUTC.toISOString()}`);
            
            // Use the address from the request body directly.
            // The booking functions (bookGHLAppointment / bookGHLAppointmentWithUser)
            // in api.js will use DEFAULT_APPOINTMENT_ADDRESS if this 'address' is null or undefined.
            const clientAddress = address;

            if (clientAddress) {
                console.log(`[BookAppointment - ${location_id}] Using address from request body for in-person appointment: ${clientAddress}`);
            } else {
                console.warn(`[BookAppointment - ${location_id}] No address provided in the request body, will use default if configured in GHL API function.`);
            }
            
            // Use enhanced booking function with client's address if available
            const bookingResult = userId 
                ? await bookGHLAppointmentWithUser(location_id, calendarId, contactId, targetSlotStartUTC, userId, clientAddress)
                : await bookGHLAppointment(location_id, calendarId, contactId, targetSlotStartUTC, clientAddress);

            if (bookingResult.success) {
                console.log(`[BookAppointment - ${location_id}] Successfully booked GHL appointment for contact ${contactId}.`);
                return reply.code(201).send({ status: "success", message: "Appointment booked successfully.", data: bookingResult.data });
            } else {
                // GHL Booking failed
                console.error(`[BookAppointment - ${location_id}] GHL booking failed for contact ${contactId}. Reason: ${bookingResult.error}`, bookingResult.details || '');
                
                sendNonFatalSlackNotification(
                    "GHL Outbound Booking Failed",
                    `[BookAppointment - ${location_id}] Failed to book GHL appointment for contact ${contactId} for slot ${targetSlotStartUTC.toISOString()}. Reason: ${bookingResult.error}`,
                    { 
                        location_id, 
                        contactId, 
                        slot_utc_iso: targetSlotStartUTC.toISOString(),
                        ghlError: bookingResult.error,
                        ghlDetails: bookingResult.details,
                        function: "/bookAppointment - GHL Booking Failure"
                    }
                );

                // Booking failed, try to find alternative slots
                console.log(`[BookAppointment - ${location_id}] Booking failed. Finding alternatives. Original request was for ${targetSlotStartUTC.toISOString()}`);

                const findAndFormatAlternativesForTwoDays = async (originalFailedSlotUTC, userIdForAlternatives) => {
                    const searchStartBaseUTC = new Date(originalFailedSlotUTC);
                    searchStartBaseUTC.setUTCHours(0, 0, 0, 0); // Start of the day of the failed slot

                    const searchWindowEndUTC = new Date(searchStartBaseUTC);
                    searchWindowEndUTC.setUTCDate(searchStartBaseUTC.getUTCDate() + 7); // 7 days from the start of the failed slot's day

                    const searchStartDateISO = searchStartBaseUTC.toISOString();
                    const searchEndDateISO = searchWindowEndUTC.toISOString();

                    let rawSlots;
                    if (userIdForAlternatives) {
                        console.log(`[BookAppointment Alt - ${location_id}] Fetching GHL slots for user ${userIdForAlternatives} for 7-day window...`);
                        rawSlots = await fetchGHLCalendarSlotsForUsers(location_id, calendarId, searchStartDateISO, searchEndDateISO, [userIdForAlternatives]);
                    } else {
                        console.log(`[BookAppointment Alt - ${location_id}] Fetching GHL slots for 7-day window starting from failed slot's day: ${searchStartDateISO} to ${searchEndDateISO}`);
                        rawSlots = await fetchGHLCalendarSlots(location_id, calendarId, searchStartDateISO, searchEndDateISO);
                    }

                    if (rawSlots === null) {
                        console.error(`[BookAppointment Alt - ${location_id}] Failed to fetch GHL slots (API/token error) for 7-day window.`);
                        return [];
                    }
                    if (!Array.isArray(rawSlots) || rawSlots.length === 0) {
                        console.log(`[BookAppointment Alt - ${location_id}] No raw slots found in the 7-day window.`);
                        return [];
                    }

                    console.log(`[BookAppointment Alt - ${location_id}] Received ${rawSlots.length} raw slots. Filtering for slots >= ${originalFailedSlotUTC.toISOString()} and grouping for first two available days.`);
                    
                    const normalizedSlots = rawSlots.map(slot => {
                        if (typeof slot === 'string') {
                            return { datetime: slot, userId: null };
                        }
                        return slot;
                    });

                    const allSlotDates = normalizedSlots
                        .map(slot => ({ date: new Date(slot.datetime), userId: slot.userId }))
                        .filter(item => !isNaN(item.date.getTime()) && item.date.getTime() >= originalFailedSlotUTC.getTime()); // Filter out past slots relative to failed attempt

                    allSlotDates.sort((a, b) => a.date - b.date); // Sort chronologically

                    if (allSlotDates.length === 0) {
                        console.log(`[BookAppointment Alt - ${location_id}] No valid future slots found after initial filter.`);
                        return [];
                    }

                    const slotsByUTCDate = {};
                    allSlotDates.forEach(slotItem => {
                        const dateKey = slotItem.date.toISOString().split('T')[0]; // YYYY-MM-DD UTC
                        if (!slotsByUTCDate[dateKey]) {
                            slotsByUTCDate[dateKey] = [];
                        }
                        slotsByUTCDate[dateKey].push(slotItem);
                    });

                    const availableUTCDates = Object.keys(slotsByUTCDate).sort();
                    const resultSlots = [];

                    if (availableUTCDates.length > 0) {
                        const firstDaySlots = slotsByUTCDate[availableUTCDates[0]];
                        resultSlots.push(...firstDaySlots);
                        console.log(`[BookAppointment Alt - ${location_id}] Added ${firstDaySlots.length} slots from the first available day: ${availableUTCDates[0]}`);

                        if (availableUTCDates.length > 1) {
                            const secondDaySlots = slotsByUTCDate[availableUTCDates[1]];
                            resultSlots.push(...secondDaySlots);
                            console.log(`[BookAppointment Alt - ${location_id}] Added ${secondDaySlots.length} slots from the second available day: ${availableUTCDates[1]}`);
                        }
                    }
                    
                    console.log(`[BookAppointment Alt - ${location_id}] Total ${resultSlots.length} alternative slots collected from first two available days.`);
                    return resultSlots.map(item => ({ datetime: item.date.toISOString(), userId: item.userId }));
                };

                const alternatives = await findAndFormatAlternativesForTwoDays(targetSlotStartUTC, userId);

                if (alternatives.length > 0) {
                    console.log(`[BookAppointment - ${location_id}] Found ${alternatives.length} alternative slots.`);
                    return reply.code(200).send({ 
                        status: "booking_failed_alternatives_available", 
                        message: "Booking failed. Alternative slots from the first two available days (starting from your original request day, within a 7-day window) are provided.", 
                        slots: alternatives, 
                        originalBookingError: bookingResult 
                    });
                }

                console.log(`[BookAppointment - ${location_id}] No alternative slots found after all attempts.`);
                return reply.code(409).send({ status: "booking_failed_no_alternatives", message: "Booking failed and no alternative slots were found within the first two available days of a 7-day search period starting from your original request day.", originalBookingError: bookingResult });
            }
        } catch (error) {
            console.error(`[BookAppointment - ${location_id}] Critical error during booking process for contact ${contactId}: ${error.message}`, error);
            sendNonFatalSlackNotification(
                "/bookAppointment Critical Error",
                `[BookAppointment - ${location_id}] Critical error during booking process for contact ${contactId}. Error: ${error.message}`,
                { location_id, contactId, appointmentDateRequest: request.body?.appointmentDate, requestBody: request.body, error: error.stack, function: "/bookAppointment route" }
            );
            return reply.code(500).send({ status: "error", message: "An unexpected server error occurred during booking." });
        }
    });

    // Endpoint to update client address during AI call
    fastify.post(`/updateContactAddress`, async (request, reply) => {
        const { contactId, fullAddress } = request.body;
        
        if (!contactId || !fullAddress) {
            console.warn(`[UpdateAddress - ${location_id}] Missing required parameters. ContactID: '${contactId}', Address: '${fullAddress}'`);
            return reply.code(400).send({ 
                status: "error", 
                message: "Missing required parameters: contactId and fullAddress are required." 
            });
        }

        try {
            console.log(`[UpdateAddress - ${location_id}] Updating address for contact ${contactId} to: ${fullAddress}`);
            
            const updateResult = await updateGHLContactAddress(location_id, contactId, fullAddress);
            
            if (updateResult.success) {
                console.log(`[UpdateAddress - ${location_id}] Successfully updated address for contact ${contactId}`);
                return reply.code(200).send({ 
                    status: "success", 
                    message: "Contact address updated successfully.",
                    data: updateResult.data 
                });
            } else {
                console.error(`[UpdateAddress - ${location_id}] Failed to update address for contact ${contactId}. Reason: ${updateResult.error}`);
                return reply.code(500).send({ 
                    status: "error", 
                    message: "Failed to update contact address.",
                    details: updateResult.error 
                });
            }
        } catch (error) {
            console.error(`[UpdateAddress - ${location_id}] Critical error updating address for contact ${contactId}: ${error.message}`, error);
            return reply.code(500).send({ 
                status: "error", 
                message: "An unexpected server error occurred while updating address." 
            });
        }
    });

} 

