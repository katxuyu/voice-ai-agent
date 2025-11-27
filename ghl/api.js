// Enhanced with additional Slack notifications for debugging and monitoring:
// - Unexpected API response structures
// - Missing parameters in function calls
// - User-filtered slots issues
// - Contact details API problems
// - Response parsing failures

import { getValidGoHighlevelToken } from './tokens.js';
import { sendNonFatalSlackNotification, sendPositiveSlackNotification } from '../slack/notifications.js';

// Function to fetch available slots from GoHighLevel
export async function fetchGHLCalendarSlots(location_id, calendarId, startDateISO, endDateISO, service = null, userId = null) {
	const accessToken = await getValidGoHighlevelToken(location_id);
	if (!accessToken) {
		console.error(`[GHL Slots] Failed to get valid GHL token for fetching slots.`);
		await sendNonFatalSlackNotification(
			'GHL Token Missing - Calendar Slots',
			`Failed to get valid GHL token for fetching calendar slots`,
			{
				locationId: location_id,
				calendarId,
				startDateISO,
				endDateISO,
				userId
			}
		).catch(console.error);
		return null; // Indicates an error in obtaining a token
	}

	// Convert ISO date strings to milliseconds for the GHL API
	const startMillis = new Date(startDateISO).getTime();
	const endMillis = new Date(endDateISO).getTime();

	// GHL API endpoint for free slots
	const slotsApiUrl = new URL(`https://services.leadconnectorhq.com/calendars/${calendarId}/free-slots`);
	slotsApiUrl.searchParams.append('startDate', startMillis.toString()); // Pass as string
	slotsApiUrl.searchParams.append('endDate', endMillis.toString());   // Pass as string

	// Add userId filter if provided
	if (userId) {
		slotsApiUrl.searchParams.append('userId', userId);
	}

	console.log(`[GHL Slots] Fetching free slots for calendar ${calendarId}${userId ? ` filtered by userId: ${userId}` : ''}. Start (ms): ${startMillis}, End (ms): ${endMillis}. URL: ${slotsApiUrl.toString()}`);

	try {
		const response = await fetch(slotsApiUrl.toString(), {
			method: 'GET',
			headers: {
				'Authorization': `Bearer ${accessToken}`,
				'Version': '2021-04-15', // Common GHL API version header
				'Accept': 'application/json'
			}
		});

		if (!response.ok) {
			const errorBody = await response.text();
			console.error(`[GHL Slots] GHL API error fetching slots for calendar ${calendarId}. Status: ${response.status}. URL: ${slotsApiUrl.toString()}. Response: ${errorBody}`);
			await sendNonFatalSlackNotification(
				'GHL Calendar Slots API Error',
				`Failed to fetch calendar slots for calendar ${calendarId}`,
				{
					locationId: location_id,
					calendarId,
					status: response.status,
					url: slotsApiUrl.toString(),
					response: errorBody,
					startDateISO,
					endDateISO,
					userId
				}
			).catch(console.error);
			return null; // Indicates an API error or non-successful response
		}

		const data = await response.json();
		// Expected GHL response structure: { "freeSlots": [ { "start": "...", "end": "..." }, ... ] }
		// Also checking for "slots" as a fallback or if the API varies.
		// UPDATED PARSING LOGIC:
		// GHL actual response structure seems to be: { "YYYY-MM-DD": { "slots": ["ISODateTime", ...] }, ... }
		let allFoundSlots = [];
		let datesProcessed = 0;
		if (data && typeof data === 'object') {
			for (const dateKey in data) {
				if (data.hasOwnProperty(dateKey) && dateKey.match(/^\d{4}-\d{2}-\d{2}$/)) { // Check if key looks like a date
					if (data[dateKey] && Array.isArray(data[dateKey].slots)) {
						console.log(`[GHL Slots] Found ${data[dateKey].slots.length} slots for date ${dateKey}.`);
						
						// If userId was provided, enhance slots with userId information
						if (userId) {
							const enhancedSlots = data[dateKey].slots.map(slot => ({
								datetime: slot,
								userId: userId
							}));
							allFoundSlots = allFoundSlots.concat(enhancedSlots);
						} else {
							allFoundSlots = allFoundSlots.concat(data[dateKey].slots);
						}
						datesProcessed++;
					} else {
						console.warn(`[GHL Slots] Date key ${dateKey} found, but no 'slots' array or unexpected structure:`, data[dateKey]);
					}
				}
			}
		}

		if (datesProcessed > 0) {
			console.log(`[GHL Slots] Successfully processed ${datesProcessed} date(s) and aggregated ${allFoundSlots.length} slots.`);
			return allFoundSlots;
		} else if (data && (data.freeSlots && Array.isArray(data.freeSlots))) { // Fallback for old structure if needed
			console.log(`[GHL Slots] Successfully fetched ${data.freeSlots.length} slots (from data.freeSlots - fallback).`);
			// Enhance with userId if provided
			if (userId) {
				return data.freeSlots.map(slot => ({
					datetime: typeof slot === 'string' ? slot : slot.start,
					userId: userId
				}));
			}
			return data.freeSlots;
		} else if (data && (data.slots && Array.isArray(data.slots))) { // Fallback for old structure if needed
			console.log(`[GHL Slots] Successfully fetched ${data.slots.length} slots (from data.slots - fallback).`);
			// Enhance with userId if provided
			if (userId) {
				return data.slots.map(slot => ({
					datetime: typeof slot === 'string' ? slot : slot.start,
					userId: userId
				}));
			}
			return data.slots;
		} else if (Array.isArray(data)) { // Fallback for direct array response
			console.log(`[GHL Slots] Successfully fetched ${data.length} slots (from direct array response - fallback).`);
			// Enhance with userId if provided
			if (userId) {
				return data.map(slot => ({
					datetime: typeof slot === 'string' ? slot : slot.start,
					userId: userId
				}));
			}
			return data;
		}
		
		console.warn(`[GHL Slots] GHL API call successful but no slots found in the expected new structure or any fallback structures. Response: ${JSON.stringify(data)}`);
		await sendNonFatalSlackNotification(
			'GHL Slots - Unexpected Response Structure',
			`GHL API returned unexpected response structure for calendar slots`,
			{
				locationId: location_id,
				calendarId,
				startDateISO,
				endDateISO,
				userId,
				responseStructure: typeof data,
				responseKeys: data ? Object.keys(data) : null,
				responsePreview: JSON.stringify(data).substring(0, 500)
			}
		).catch(console.error);
		return []; // No slots found, but the API call itself was okay.
	} catch (error) {
		console.error(`[GHL Slots] Exception during fetchGHLCalendarSlots for calendar ${calendarId}: ${error.message}`, error);
		await sendNonFatalSlackNotification(
			'GHL Calendar Slots Exception',
			`Exception during fetchGHLCalendarSlots for calendar ${calendarId}`,
			{
				locationId: location_id,
				calendarId,
				error: error.message,
				stack: error.stack,
				startDateISO,
				endDateISO,
				userId
			}
		).catch(console.error);
		return null; // Indicates a critical error during the fetch operation (e.g., network issue)
	}
}

// Function to fetch available slots from GoHighLevel filtered by specific userIds
// Returns slots with userId information for province-specific appointments
export async function fetchGHLCalendarSlotsForUsers(location_id, calendarId, startDateISO, endDateISO, userIds) {
	const accessToken = await getValidGoHighlevelToken(location_id);
	if (!accessToken) {
		console.error(`[GHL Slots] Failed to get valid GHL token for fetching user-filtered slots.`);
		await sendNonFatalSlackNotification(
			'GHL Token Missing - User-Filtered Slots',
			`Failed to get valid GHL token for fetching user-filtered calendar slots`,
			{
				locationId: location_id,
				calendarId,
				startDateISO,
				endDateISO,
				userIds
			}
		).catch(console.error);
		return null;
	}

	if (!userIds || userIds.length === 0) {
		console.error(`[GHL Slots] No userIds provided for filtering slots.`);
		return [];
	}

	// Convert ISO date strings to milliseconds for the GHL API
	const startMillis = new Date(startDateISO).getTime();
	const endMillis = new Date(endDateISO).getTime();

	// GHL API endpoint for free slots
	const slotsApiUrl = new URL(`https://services.leadconnectorhq.com/calendars/${calendarId}/free-slots`);
	slotsApiUrl.searchParams.append('startDate', startMillis.toString());
	slotsApiUrl.searchParams.append('endDate', endMillis.toString());
	
	// Add user filtering based on the number of userIds
	if (userIds.length === 1) {
		slotsApiUrl.searchParams.append('userId', userIds[0]);
	} else {
		// Use userIds[] parameter for multiple users
		userIds.forEach(userId => {
			slotsApiUrl.searchParams.append('userIds[]', userId);
		});
	}

	console.log(`[GHL Slots] Fetching free slots for calendar ${calendarId} filtered by userIds: ${userIds.join(', ')}. Start (ms): ${startMillis}, End (ms): ${endMillis}. URL: ${slotsApiUrl.toString()}`);

	try {
		const response = await fetch(slotsApiUrl.toString(), {
			method: 'GET',
			headers: {
				'Authorization': `Bearer ${accessToken}`,
				'Version': '2021-04-15',
				'Accept': 'application/json'
			}
		});

		if (!response.ok) {
			const errorBody = await response.text();
			console.error(`[GHL Slots] GHL API error fetching user-filtered slots for calendar ${calendarId}. Status: ${response.status}. URL: ${slotsApiUrl.toString()}. Response: ${errorBody}`);
			await sendNonFatalSlackNotification(
				'GHL Calendar Slots API Error',
				`Failed to fetch user-filtered slots for calendar ${calendarId}`,
				{
					locationId: location_id,
					calendarId,
					userIds,
					status: response.status,
					url: slotsApiUrl.toString(),
					response: errorBody
				}
			).catch(console.error);
			return null;
		}

		const data = await response.json();
		console.log(`[GHL Slots] Raw GHL API response for user-filtered slots:`, JSON.stringify(data));

		// Enhanced parsing logic to preserve userId information
		let allFoundSlots = [];
		let datesProcessed = 0;
		
		if (data && typeof data === 'object') {
			for (const dateKey in data) {
				if (data.hasOwnProperty(dateKey) && dateKey.match(/^\d{4}-\d{2}-\d{2}$/)) {
					if (data[dateKey] && data[dateKey].slots) {
						const dateSlots = data[dateKey].slots;
						console.log(`[GHL Slots] Found ${dateSlots.length} slots for date ${dateKey}.`);

						// Handle both array of strings and array of objects
						if (Array.isArray(dateSlots)) {
							dateSlots.forEach(slot => {
								if (typeof slot === 'string') {
									// If slot is just a datetime string, we need to determine which userId it belongs to
									// This might require additional API calls or different parsing logic
									// For now, we'll distribute evenly among available userIds as a fallback
									const assignedUserId = userIds[allFoundSlots.length % userIds.length];
									allFoundSlots.push({
										datetime: slot,
										userId: assignedUserId
									});
								} else if (typeof slot === 'object' && slot.datetime && slot.userId) {
									// If slot already has userId information
									allFoundSlots.push({
										datetime: slot.datetime,
										userId: slot.userId
									});
								} else if (typeof slot === 'object' && slot.start) {
									// Handle different object structures
									const assignedUserId = slot.userId || userIds[allFoundSlots.length % userIds.length];
									allFoundSlots.push({
										datetime: slot.start,
										userId: assignedUserId
									});
								}
							});
						}
						datesProcessed++;
					} else {
						console.warn(`[GHL Slots] Date key ${dateKey} found, but no 'slots' array or unexpected structure:`, data[dateKey]);
					}
				}
			}
		}

		// Handle alternative response structures if the above doesn't work
		if (datesProcessed === 0) {
			// Try alternative parsing methods similar to original function
			let rawSlots = [];
			if (data && data.freeSlots && Array.isArray(data.freeSlots)) {
				rawSlots = data.freeSlots;
			} else if (data && data.slots && Array.isArray(data.slots)) {
				rawSlots = data.slots;
			} else if (Array.isArray(data)) {
				rawSlots = data;
			}

			// Convert raw slots to enhanced format with userId
			rawSlots.forEach(slot => {
				const slotDatetime = typeof slot === 'string' ? slot : (slot.start || slot.datetime);
				const slotUserId = (typeof slot === 'object' && slot.userId) ? slot.userId : userIds[allFoundSlots.length % userIds.length];
				
				if (slotDatetime) {
					allFoundSlots.push({
						datetime: slotDatetime,
						userId: slotUserId
					});
				}
			});

			if (rawSlots.length > 0) {
				console.log(`[GHL Slots] Processed ${rawSlots.length} slots using fallback parsing.`);
			}
		}

		if (allFoundSlots.length > 0) {
			console.log(`[GHL Slots] Successfully processed ${datesProcessed} date(s) and found ${allFoundSlots.length} user-filtered slots.`);
			
			// Sort slots by datetime to ensure chronological order
			allFoundSlots.sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
			
			// Return only the first 3 slots to the AI, but log that we parsed all slots
			const slotsToReturn = allFoundSlots.slice(0, 3);
			console.log(`[GHL Slots] Returning ${slotsToReturn.length} slots to AI (limited from ${allFoundSlots.length} total parsed slots).`);
			
			return slotsToReturn;
		} else {
			console.warn(`[GHL Slots] GHL API call successful but no user-filtered slots found. Response: ${JSON.stringify(data)}`);
			await sendNonFatalSlackNotification(
				'GHL User-Filtered Slots - No Slots Found',
				`GHL API returned no user-filtered slots despite successful call`,
				{
					locationId: location_id,
					calendarId,
					userIds,
					startDateISO,
					endDateISO,
					responseStructure: typeof data,
					responseKeys: data ? Object.keys(data) : null,
					responsePreview: JSON.stringify(data).substring(0, 300),
					troubleshooting: 'Check if users have available slots in the requested time range'
				}
			).catch(console.error);
			return [];
		}

	} catch (error) {
		console.error(`[GHL Slots] Exception during fetchGHLCalendarSlotsForUsers for calendar ${calendarId}: ${error.message}`, error);
		await sendNonFatalSlackNotification(
			'GHL User-Filtered Slots Exception',
			`Exception during fetchGHLCalendarSlotsForUsers for calendar ${calendarId}`,
			{
				locationId: location_id,
				calendarId,
				userIds,
				error: error.message,
				stack: error.stack,
				startDateISO,
				endDateISO
			}
		).catch(console.error);
		return null;
	}
}

// Helper function to book an appointment in GoHighLevel
export async function bookGHLAppointment(location_id, calendarId, contactId, startTimeUTC, appointmentAddress = null, userId = null) {
	const accessToken = await getValidGoHighlevelToken(location_id);
	if (!accessToken) {
		console.error(`[GHL Bookings] Failed to get valid GHL token for booking appointment.`);
		await sendNonFatalSlackNotification(
			'GHL Token Missing - Appointment Booking',
			`Failed to get valid GHL token for booking appointment`,
			{
				locationId: location_id,
				calendarId,
				contactId,
				startTime: startTimeUTC.toISOString(),
				userId
			}
		).catch(console.error);
		return { success: false, error: "Failed to obtain GHL token", type: "token_error" };
	}

	const bookingApiUrl = 'https://services.leadconnectorhq.com/calendars/events/appointments';
	
	// Import the default appointment address from config
	const { DEFAULT_APPOINTMENT_ADDRESS } = await import('../config.js');
	
	const payload = {
		calendarId: calendarId,
		locationId: location_id,
		contactId: contactId,
		startTime: startTimeUTC.toISOString(), // Must be UTC ISO string
		locationType: "Address", // Meeting location type - indicates in-person meeting
		address: appointmentAddress || DEFAULT_APPOINTMENT_ADDRESS, // Actual address where meeting takes place
		userId: userId,
	};

	console.log(`[GHL Bookings] Attempting to book appointment for contact ${contactId} on calendar ${calendarId}. StartTime (UTC): ${payload.startTime}. Payload:`, JSON.stringify(payload));

	try {
		const response = await fetch(bookingApiUrl, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${accessToken}`,
				'Version': '2021-04-15', // Common GHL API version header
				'Accept': 'application/json',
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(payload)
		});

		const responseBodyText = await response.text(); // Get text for robust error logging

		if (response.ok) { // status 200-299
			console.log(`[GHL Bookings] Successfully booked appointment. Status: ${response.status}. Response: ${responseBodyText}`);
			
			// Send positive notification for successful booking
			await sendPositiveSlackNotification(
				'Appointment Successfully Booked',
				`Successfully booked appointment for contact ${contactId}`,
				{
					locationId: location_id,
					calendarId,
					contactId,
					startTime: startTimeUTC.toISOString(),
					userId,
					status: response.status
				}
			).catch(console.error);
			
			try {
				return { success: true, data: JSON.parse(responseBodyText) };
			} catch (parseError) {
				// If parsing fails but status was ok, still consider it a success
				console.warn(`[GHL Bookings] Successfully booked (status ${response.status}) but couldn't parse JSON response: ${responseBodyText}`);
				return { success: true, data: { message: "Booking successful, unparsable response." } };
			}
		} else {
			console.error(`[GHL Bookings] GHL API error booking appointment. Status: ${response.status}. URL: ${bookingApiUrl}. Response: ${responseBodyText}`);
			
			// Send non-fatal notification for booking failure
			await sendNonFatalSlackNotification(
				'GHL Appointment Booking Failed',
				`Failed to book appointment for contact ${contactId}`,
				{
					locationId: location_id,
					calendarId,
					contactId,
					startTime: startTimeUTC.toISOString(),
					userId,
					status: response.status,
					url: bookingApiUrl,
					response: responseBodyText
				}
			).catch(console.error);
			
			// Try to parse error for more details if GHL provides structured errors
			let errorDetails = responseBodyText;
			try {
				errorDetails = JSON.parse(responseBodyText);
			} catch (e) { /* Keep as text if not JSON */ }
			return { success: false, error: "GHL API Error", status: response.status, details: errorDetails, type: "api_error" };
		}
	} catch (error) {
		console.error(`[GHL Bookings] Exception during bookGHLAppointment: ${error.message}`, error);
		await sendNonFatalSlackNotification(
			'GHL Appointment Booking Exception',
			`Exception during bookGHLAppointment for contact ${contactId}`,
			{
				locationId: location_id,
				calendarId,
				contactId,
				startTime: startTimeUTC.toISOString(),
				userId,
				error: error.message,
				stack: error.stack
			}
		).catch(console.error);
		return { success: false, error: `Exception: ${error.message}`, type: "exception" };
	}
}

// Enhanced function to book an appointment with specific user assignment
export async function bookGHLAppointmentWithUser(location_id, calendarId, contactId, startTimeUTC, userId, appointmentAddress = null) {
	const accessToken = await getValidGoHighlevelToken(location_id);
	if (!accessToken) {
		console.error(`[GHL Bookings] Failed to get valid GHL token for booking appointment.`);
		await sendNonFatalSlackNotification(
			'GHL Token Missing - User-Specific Booking',
			`Failed to get valid GHL token for booking appointment with user ${userId}`,
			{
				locationId: location_id,
				calendarId,
				contactId,
				startTime: startTimeUTC.toISOString(),
				userId
			}
		).catch(console.error);
		return { success: false, error: "Failed to obtain GHL token", type: "token_error" };
	}

	const bookingApiUrl = 'https://services.leadconnectorhq.com/calendars/events/appointments';
	
	// Import the default appointment address from config
	const { DEFAULT_APPOINTMENT_ADDRESS } = await import('../config.js');
	
	const payload = {
		calendarId: calendarId,
		locationId: location_id,
		contactId: contactId,
		startTime: startTimeUTC.toISOString(), // Must be UTC ISO string
		locationType: "Address", // Meeting location type - indicates in-person meeting
		address: appointmentAddress || DEFAULT_APPOINTMENT_ADDRESS, // Actual address where meeting takes place
	};

	// Add userId if provided (for province-specific appointments)
	if (userId) {
		payload.userId = userId;
		console.log(`[GHL Bookings] Booking appointment with specific agent userId: ${userId}`);
	}

	console.log(`[GHL Bookings] Attempting to book appointment for contact ${contactId} on calendar ${calendarId}. StartTime (UTC): ${payload.startTime}. Payload:`, JSON.stringify(payload));

	try {
		const response = await fetch(bookingApiUrl, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${accessToken}`,
				'Version': '2021-04-15', // Common GHL API version header
				'Accept': 'application/json',
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(payload)
		});

		const responseBodyText = await response.text(); // Get text for robust error logging

		if (response.ok) { // status 200-299
			console.log(`[GHL Bookings] Successfully booked appointment${userId ? ` with agent ${userId}` : ''}. Status: ${response.status}. Response: ${responseBodyText}`);
			
			// Send positive notification for successful booking
			await sendPositiveSlackNotification(
				'User-Specific Appointment Successfully Booked',
				`Successfully booked appointment for contact ${contactId}${userId ? ` with agent ${userId}` : ''}`,
				{
					locationId: location_id,
					calendarId,
					contactId,
					startTime: startTimeUTC.toISOString(),
					userId,
					status: response.status
				}
			).catch(console.error);
			
			try {
				return { success: true, data: JSON.parse(responseBodyText) };
			} catch (parseError) {
				// If parsing fails but status was ok, still consider it a success
				console.warn(`[GHL Bookings] Successfully booked (status ${response.status}) but couldn't parse JSON response: ${responseBodyText}`);
				return { success: true, data: { message: "Booking successful, unparsable response." } };
			}
		} else {
			console.error(`[GHL Bookings] GHL API error booking appointment${userId ? ` with agent ${userId}` : ''}. Status: ${response.status}. URL: ${bookingApiUrl}. Response: ${responseBodyText}`);
			
			// Send non-fatal notification for booking failure
			await sendNonFatalSlackNotification(
				'GHL User-Specific Booking Failed',
				`Failed to book appointment for contact ${contactId}${userId ? ` with agent ${userId}` : ''}`,
				{
					locationId: location_id,
					calendarId,
					contactId,
					startTime: startTimeUTC.toISOString(),
					userId,
					status: response.status,
					url: bookingApiUrl,
					response: responseBodyText
				}
			).catch(console.error);
			
			// Try to parse error for more details if GHL provides structured errors
			let errorDetails = responseBodyText;
			try {
				errorDetails = JSON.parse(responseBodyText);
			} catch (e) { /* Keep as text if not JSON */ }
			return { success: false, error: "GHL API Error", status: response.status, details: errorDetails, type: "api_error" };
		}
	} catch (error) {
		console.error(`[GHL Bookings] Exception during bookGHLAppointmentWithUser: ${error.message}`, error);
		await sendNonFatalSlackNotification(
			'GHL User-Specific Booking Exception',
			`Exception during bookGHLAppointmentWithUser for contact ${contactId}`,
			{
				locationId: location_id,
				calendarId,
				contactId,
				startTime: startTimeUTC.toISOString(),
				userId,
				error: error.message,
				stack: error.stack
			}
		).catch(console.error);
		return { success: false, error: `Exception: ${error.message}`, type: "exception" };
	}
}

/**
 * Fetches contact details from GoHighLevel.
 * @param {string} locationId The GHL Location ID.
 * @param {string} contactId The GHL Contact ID.
 * @returns {Promise<Object|null>} Contact details or null.
 */
export async function getGHLContactDetails(locationId, contactId) {
	if (!locationId || !contactId) {
		console.error("[GHL Contact] Missing locationId or contactId for fetching details.");
		await sendNonFatalSlackNotification(
			'GHL Contact Details - Missing Parameters',
			`Missing required parameters for fetching contact details`,
			{
				locationId: locationId || 'missing',
				contactId: contactId || 'missing',
				function: 'getGHLContactDetails'
			}
		).catch(console.error);
		return null;
	}
	const accessToken = await getValidGoHighlevelToken(locationId);
	if (!accessToken) {
		console.error(`[GHL Contact - ${contactId}] Failed to get valid GHL token.`);
		await sendNonFatalSlackNotification(
			'GHL Token Missing - Contact Details',
			`Failed to get valid GHL token for fetching contact details`,
			{
				locationId,
				contactId
			}
		).catch(console.error);
		return null;
	}

	const apiUrl = `https://services.leadconnectorhq.com/contacts/${contactId}`;
	console.log(`[GHL Contact - ${contactId}] Fetching details from ${apiUrl}`);

	try {
		const response = await fetch(apiUrl, {
			method: 'GET',
			headers: {
				'Authorization': `Bearer ${accessToken}`,
				'Version': '2021-07-28', // Or a relevant GHL API version
				'Accept': 'application/json'
			}
		});

		if (!response.ok) {
			const errorBody = await response.text();
			console.error(`[GHL Contact - ${contactId}] API error: ${response.status}. Body: ${errorBody}`);
			await sendNonFatalSlackNotification(
				'GHL Contact Details API Error',
				`Failed to fetch contact details for contact ${contactId}`,
				{
					locationId,
					contactId,
					status: response.status,
					url: apiUrl,
					response: errorBody
				}
			).catch(console.error);
			return null;
		}
		const data = await response.json();
		console.log(`[GHL Contact - ${contactId}] Full response:`, JSON.stringify(data, null, 2));
		if (data && data.contact) { // Common structure with "contact" wrapper
			return {
				phone: data.contact.phone || null,
				firstName: data.contact.firstName || "",
				lastName: data.contact.lastName || "",
				fullName: data.contact.fullName || `${data.contact.firstName || ""} ${data.contact.lastName || ""}`.trim(),
				email: data.contact.email || null,
				contactId: data.contact.id || contactId,
				address: data.contact.address1 || data.contact.address || null, // Include address for appointment location
				customFields: data.contact.customFields || [],
				tags: data.contact.tags || []
			};
		} else if (data) { // Fallback if fields are at the root
			console.log(`[GHL Contact - ${contactId}] Attempting to parse contact data from root of response.`);
			return {
				phone: data.phone || null,
				firstName: data.firstName || "",
				lastName: data.lastName || "",
				fullName: data.fullName || `${data.firstName || ""} ${data.lastName || ""}`.trim(),
				email: data.email || null,
				contactId: data.id || contactId,
				address: data.address1 || data.address || null, // Include address for appointment location
				customFields: data.customFields || [],
				tags: data.tags || []
			};
		}
		console.warn(`[GHL Contact - ${contactId}] Unexpected response structure. Full response:`, JSON.stringify(data, null, 2));
		await sendNonFatalSlackNotification(
			'GHL Contact Details - Unexpected Response',
			`GHL contact details API returned unexpected response structure`,
			{
				locationId,
				contactId,
				responseStructure: typeof data,
				responseKeys: data ? Object.keys(data) : null,
				responsePreview: JSON.stringify(data).substring(0, 500),
				function: 'getGHLContactDetails'
			}
		).catch(console.error);
		return null;

	} catch (error) {
		console.error(`[GHL Contact - ${contactId}] Exception fetching details: ${error.message}`, error);
		await sendNonFatalSlackNotification(
			'GHL Contact Details Exception',
			`Exception fetching contact details for contact ${contactId}`,
			{
				locationId,
				contactId,
				error: error.message,
				stack: error.stack
			}
		).catch(console.error);
		return null;
	}
}

/**
 * Updates a contact's address in GoHighLevel when AI collects complete address during call
 * @param {string} locationId The GHL Location ID.
 * @param {string} contactId The GHL Contact ID.
 * @param {string} fullAddress The complete address collected by AI.
 * @returns {Promise<Object>} Update result with success status.
 */
export async function updateGHLContactAddress(locationId, contactId, fullAddress) {
	if (!locationId || !contactId || !fullAddress) {
		console.error("[GHL Contact Update] Missing required parameters for address update.");
		return { success: false, error: "Missing required parameters" };
	}

	const accessToken = await getValidGoHighlevelToken(locationId);
	if (!accessToken) {
		console.error(`[GHL Contact Update - ${contactId}] Failed to get valid GHL token.`);
		await sendNonFatalSlackNotification(
			'GHL Token Missing - Address Update',
			`Failed to get valid GHL token for updating contact address`,
			{
				locationId,
				contactId,
				fullAddress
			}
		).catch(console.error);
		return { success: false, error: "Failed to obtain GHL token" };
	}

	const apiUrl = `https://services.leadconnectorhq.com/contacts/${contactId}`;
	
	// Prepare address update payload
	const updatePayload = {
		address1: fullAddress.trim()
	};

	console.log(`[GHL Contact Update - ${contactId}] Updating address to: ${fullAddress}`);

	try {
		const response = await fetch(apiUrl, {
			method: 'PUT',
			headers: {
				'Authorization': `Bearer ${accessToken}`,
				'Version': '2021-07-28',
				'Accept': 'application/json',
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(updatePayload)
		});

		const responseBodyText = await response.text();

		if (response.ok) {
			console.log(`[GHL Contact Update - ${contactId}] Successfully updated address. Status: ${response.status}`);
			
			// Send positive notification for successful address update
			await sendPositiveSlackNotification(
				'Contact Address Successfully Updated',
				`Successfully updated address for contact ${contactId}`,
				{
					locationId,
					contactId,
					fullAddress,
					status: response.status
				}
			).catch(console.error);
			
			try {
				return { success: true, data: JSON.parse(responseBodyText) };
			} catch (parseError) {
				return { success: true, data: { message: "Address update successful" } };
			}
		} else {
			console.error(`[GHL Contact Update - ${contactId}] API error updating address. Status: ${response.status}. Response: ${responseBodyText}`);
			
			// Send non-fatal notification for address update failure
			await sendNonFatalSlackNotification(
				'GHL Address Update Failed',
				`Failed to update address for contact ${contactId}`,
				{
					locationId,
					contactId,
					fullAddress,
					status: response.status,
					url: apiUrl,
					response: responseBodyText
				}
			).catch(console.error);
			
			return { success: false, error: "GHL API Error", status: response.status, details: responseBodyText };
		}
	} catch (error) {
		console.error(`[GHL Contact Update - ${contactId}] Exception updating address: ${error.message}`, error);
		await sendNonFatalSlackNotification(
			'GHL Address Update Exception',
			`Exception updating address for contact ${contactId}`,
			{
				locationId,
				contactId,
				fullAddress,
				error: error.message,
				stack: error.stack
			}
		).catch(console.error);
		return { success: false, error: `Exception: ${error.message}` };
	}
}

/**
 * Adds a note to a GoHighLevel contact
 * @param {string} locationId The GHL Location ID.
 * @param {string} contactId The GHL Contact ID.
 * @param {string} noteBody The note content to add.
 * @returns {Promise<Object>} Result with success status.
 */
export async function addGHLContactNote(locationId, contactId, noteBody) {
	if (!locationId || !contactId || !noteBody) {
		console.error("[GHL Note] Missing required parameters for adding note.");
		return { success: false, error: "Missing required parameters" };
	}

	const accessToken = await getValidGoHighlevelToken(locationId);
	if (!accessToken) {
		console.error(`[GHL Note - ${contactId}] Failed to get valid GHL token.`);
		await sendNonFatalSlackNotification(
			'GHL Token Missing - Add Note',
			`Failed to get valid GHL token for adding contact note`,
			{
				locationId,
				contactId,
				noteBody: noteBody.substring(0, 100) + '...'
			}
		).catch(console.error);
		return { success: false, error: "Failed to obtain GHL token" };
	}

	const apiUrl = `https://services.leadconnectorhq.com/contacts/${contactId}/notes`;
	
	const payload = {
		body: noteBody
	};

	console.log(`[GHL Note - ${contactId}] Adding note: ${noteBody.substring(0, 100)}...`);

	try {
		const response = await fetch(apiUrl, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${accessToken}`,
				'Version': '2021-07-28',
				'Accept': 'application/json',
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(payload)
		});

		const responseBodyText = await response.text();

		if (response.ok) {
			console.log(`[GHL Note - ${contactId}] Successfully added note. Status: ${response.status}`);
			
			// Send positive notification for successful note addition
			await sendPositiveSlackNotification(
				'Contact Note Successfully Added',
				`Successfully added note to contact ${contactId}`,
				{
					locationId,
					contactId,
					noteBody: noteBody.substring(0, 100) + '...',
					status: response.status
				}
			).catch(console.error);
			
			try {
				return { success: true, data: JSON.parse(responseBodyText) };
			} catch (parseError) {
				return { success: true, data: { message: "Note added successfully" } };
			}
		} else {
			console.error(`[GHL Note - ${contactId}] API error adding note. Status: ${response.status}. Response: ${responseBodyText}`);
			
			// Send non-fatal notification for note addition failure
			await sendNonFatalSlackNotification(
				'GHL Add Note Failed',
				`Failed to add note to contact ${contactId}`,
				{
					locationId,
					contactId,
					noteBody: noteBody.substring(0, 100) + '...',
					status: response.status,
					url: apiUrl,
					response: responseBodyText
				}
			).catch(console.error);
			
			return { success: false, error: "GHL API Error", status: response.status, details: responseBodyText };
		}
	} catch (error) {
		console.error(`[GHL Note - ${contactId}] Exception adding note: ${error.message}`, error);
		await sendNonFatalSlackNotification(
			'GHL Add Note Exception',
			`Exception adding note to contact ${contactId}`,
			{
				locationId,
				contactId,
				noteBody: noteBody.substring(0, 100) + '...',
				error: error.message,
				stack: error.stack
			}
		).catch(console.error);
		return { success: false, error: `Exception: ${error.message}` };
	}
} 