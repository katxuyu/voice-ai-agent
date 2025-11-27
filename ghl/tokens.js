import { openDb, closeDb, run, get } from '../db.js';

const GOHIGHLEVEL_TOKEN_URL = "https://services.leadconnectorhq.com/oauth/token"

/**
 * Saves or updates GoHighLevel tokens for a specific location in the database.
 * @param {string} location_id The GoHighLevel location ID.
 * @param {string} access_token
 * @param {string} refresh_token
 * @param {Date|null} expires_at
 * @returns {Promise<boolean>} Success status
 */
export async function saveGoHighlevelTokens(location_id, access_token, refresh_token, expires_at = null) {
	if (!location_id) {
		console.error("Error saving GoHighLevel tokens: location_id is required.");
		return false;
	}
	let db;
	try {
		const expires_at_iso = expires_at instanceof Date ? expires_at.toISOString() : null;
		db = await openDb();

		// Use INSERT OR REPLACE to handle both new inserts and updates based on location_id
		const sql = `INSERT OR REPLACE INTO gohighlevel_tokens
					 (location_id, access_token, refresh_token, expires_at)
					 VALUES (?, ?, ?, ?)`;
		await run(db, sql, [location_id, access_token, refresh_token, expires_at_iso]);

		console.log(`Saved GoHighLevel tokens for location_id: ${location_id}`);
		return true;

	} catch (error) {
		console.error(`Error saving GoHighLevel tokens for location ${location_id}: ${error.message}`, { error });
		return false;
	} finally {
		await closeDb(db);
	}
}

/**
 * Retrieves GoHighLevel tokens for a specific location from the database.
 * @param {string} location_id The GoHighLevel location ID.
 * @returns {Promise<Object|null>} Token data or null if not found/error
 */
export async function getGoHighlevelTokens(location_id) {
	if (!location_id) {
		console.error("Error retrieving GoHighLevel tokens: location_id is required.");
		return null;
	}
	let db;
	try {
		db = await openDb();
		// Fetch tokens for the specific location_id
		const row = await get(db,
			`SELECT location_id, access_token, refresh_token, expires_at
			 FROM gohighlevel_tokens
			 WHERE location_id = ?`,
			[location_id]
		);

		if (row) {
			const token_data = { ...row }; // Copy row data
			// Parse expires_at back to datetime object
			if (token_data.expires_at) {
				try {
					token_data.expires_at = new Date(token_data.expires_at);
					if (isNaN(token_data.expires_at.getTime())) {
						console.warn(`[${location_id}] Could not parse stored expires_at (Invalid Date): ${row.expires_at}`);
						token_data.expires_at = null;
					}
				} catch (error) {
					console.warn(`[${location_id}] Error parsing stored expires_at: ${row.expires_at}`, error);
					token_data.expires_at = null;
				}
			}
			return token_data;
		}

		console.log(`No GoHighLevel tokens found for location_id: ${location_id}`);
		return null; // No tokens found for this location

	} catch (error) {
		console.error(`Error retrieving GoHighLevel tokens for location ${location_id}: ${error.message}`, { error });
		return null; // Return null on error
	} finally {
		await closeDb(db);
	}
}

/**
 * Refreshes the GoHighLevel access token for a specific location using its stored refresh token.
 * @param {string} location_id The GoHighLevel location ID.
 * @returns {Promise<string|null>} New access token or null if refresh failed
 */
export async function refreshGoHighlevelToken(location_id) {
	if (!location_id) {
		console.error("[GOHIGHLEVEL] Cannot refresh: location_id is required.");
		return null;
	}
	// Check for required environment variables (Client ID & Secret still from env)
	const { GOHIGHLEVEL_CLIENT_ID, GOHIGHLEVEL_CLIENT_SECRET } = process.env;
	if (!GOHIGHLEVEL_CLIENT_ID || !GOHIGHLEVEL_CLIENT_SECRET) {
		console.error("[GOHIGHLEVEL] Missing GoHighLevel environment variables for token refresh (CLIENT_ID, CLIENT_SECRET).");
		return null;
	}

	let tokens;
	try {
		// Get stored tokens for the specific location
		tokens = await getGoHighlevelTokens(location_id);
		if (!tokens || !tokens.refresh_token) {
			console.error(`[GOHIGHLEVEL - ${location_id}] Cannot refresh: No refresh token found in database for this location.`);
			return null;
		}

		const refresh_token = tokens.refresh_token;

		// Prepare the refresh token request body
		const refresh_payload = new URLSearchParams({
			client_id: GOHIGHLEVEL_CLIENT_ID, // From env
			client_secret: GOHIGHLEVEL_CLIENT_SECRET, // From env
			grant_type: "refresh_token",
			refresh_token: refresh_token,
			user_type: "Location", // Must match original token type
		});

		console.log(`[GOHIGHLEVEL - ${location_id}] Attempting to refresh GoHighLevel access token...`);

		const response = await fetch(GOHIGHLEVEL_TOKEN_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			body: refresh_payload
		});

		const response_text = await response.text(); // Get text first for logging in case of JSON error
		console.log(`[GOHIGHLEVEL - ${location_id}] Refresh Token Response Status: ${response.status}`);
		// console.debug(`Refresh Token Response Body: ${response_text}`); // More detailed logging if needed

		if (response.ok) { // Check status code 200-299
			let token_data;
			try {
				token_data = JSON.parse(response_text);
			} catch (parseError) {
				console.error(`[GOHIGHLEVEL - ${location_id}] Failed to parse JSON response during token refresh: ${response_text}`, parseError);
				return null;
			}

			// Extract new tokens
			const new_access_token = token_data.access_token;
			// GHL might return a new refresh token, use it if provided, otherwise keep the old one
			const new_refresh_token = token_data.refresh_token || refresh_token;
			const expires_in = token_data.expires_in; // Seconds
			// IMPORTANT: Use the location_id passed to the function, not one potentially returned by the refresh response (which might be absent or incorrect)
			const current_location_id = location_id;

			if (!new_access_token) {
				console.error(`[GOHIGHLEVEL - ${current_location_id}] Refresh successful but 'access_token' not found in response: ${response_text}`);
				return null;
			}

			// Calculate new expiry time (UTC)
			let expires_at = null;
			if (expires_in && !isNaN(parseInt(expires_in))) {
				expires_at = new Date(Date.now() + (parseInt(expires_in) - 60) * 1000); // 60s buffer
			} else if (expires_in) {
				console.warn(`[GOHIGHLEVEL - ${current_location_id}] Invalid expires_in value received: ${expires_in}. Cannot calculate expiry.`);
			}

			// Save the NEW tokens to the database FOR THE CORRECT LOCATION
			const save_success = await saveGoHighlevelTokens(current_location_id, new_access_token, new_refresh_token, expires_at);
			if (save_success) {
				console.log(`[GOHIGHLEVEL - ${current_location_id}] Successfully refreshed and saved GoHighLevel tokens. Expires around: ${expires_at ? expires_at.toISOString() : 'N/A'}`);
				return new_access_token; // Return the new access token
			} else {
				console.error(`[GOHIGHLEVEL - ${current_location_id}] Failed to save refreshed GoHighLevel tokens after successful refresh.`);
				// Return the new token anyway, but log the save error
				return new_access_token;
			}
		} else {
			console.error(`[GOHIGHLEVEL - ${location_id}] Failed to refresh GoHighLevel token. Status: ${response.status}, Details: ${response_text}`);
			if ([400, 401].includes(response.status)) {
				console.error(`[GOHIGHLEVEL - ${location_id}] Refresh token might be invalid or expired. Re-authorization for this location required.`);
				// Consider deleting the invalid tokens from DB (implement carefully)
				// await deleteTokensFromDB(location_id); // Example function call
			}
			return null; // Refresh failed
		}
	} catch (error) {
		// Catch errors from fetch, DB operations, etc.
		console.error(`[GOHIGHLEVEL - ${location_id}] Unexpected error during GoHighLevel token refresh: ${error.message}`, { error });
		return null;
	}
}

/**
 * Gets a valid GoHighLevel access token for a specific location, attempting refresh if necessary.
 * @param {string} location_id The GoHighLevel location ID.
 * @returns {Promise<string|null>} Valid access token or null if unavailable/refresh fails
 */
export async function getValidGoHighlevelToken(location_id) {
	if (!location_id) {
		console.error("Cannot get valid token: location_id is required.");
		return null;
	}

	const tokens = await getGoHighlevelTokens(location_id);

	if (!tokens || !tokens.access_token) {
		console.warn(`[${location_id}] No GoHighLevel tokens found in database for this location. Authorization may be required.`);
		return null;
	}

	const access_token = tokens.access_token;
	const expires_at = tokens.expires_at; // This is now a Date object or null

	// Check if token is expired
	let is_expired = true; // Assume expired if no expiry info or invalid date
	if (expires_at instanceof Date && !isNaN(expires_at.getTime())) {
		const now_utc = new Date(); // Current time in UTC
		if (expires_at > now_utc) {
			is_expired = false;
			console.log(`[${location_id}] Using existing valid GoHighLevel token (expires: ${expires_at.toISOString()})`);
		} else {
			console.log(`[${location_id}] GoHighLevel token expired at ${expires_at.toISOString()}. Attempting refresh...`);
		}
	} else if (expires_at) {
		// Log if expires_at was present but not a valid date after parsing
		console.warn(`[${location_id}] Stored expires_at was not a valid Date object after retrieval: ${tokens.expires_at}. Assuming expired.`);
	} else {
		// Log if expires_at was null/undefined from DB
		console.log(`[${location_id}] No expiry information found for GoHighLevel token. Assuming expired/refresh needed.`);
		is_expired = true;
	}

	if (is_expired) {
		console.log(`[${location_id}] GoHighLevel access token is expired or expiry unknown. Attempting refresh...`);
		// Attempt to refresh the token FOR THIS LOCATION
		const refreshed_token = await refreshGoHighlevelToken(location_id);
		if (refreshed_token) {
			return refreshed_token; // Return the newly refreshed token
		} else {
			console.error(`[${location_id}] Token refresh failed. Manual re-authorization may be required for this location.`);
			return null; // Refresh failed
		}
	} else {
		// Token is still valid
		return access_token;
	}
} 