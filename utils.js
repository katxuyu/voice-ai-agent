import fetch from 'node-fetch';
import { google } from 'googleapis';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GEMINI_API_KEY } from './config.js';

// Google Sheets configuration
const GOOGLE_SHEETS_ID = '1re-raBHG6l47RiM5pFySi8aYqgXKi3Yroj6MYpqSaHc';
const GOOGLE_SHEETS_RANGE = 'Sheet1!A:D'; // Columns A-D to get COMUNE, CAP, PROVINCIA, REGIONE

// Cache for ZIP code to province mapping to avoid repeated API calls
let zipCodeProvinceCache = new Map();
let cacheLastUpdated = null;
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Checks if the current server time is within operating hours (8 AM to 8 PM) in Italian timezone.
 * @returns {boolean} True if within operating hours, false otherwise.
 */
export function isOperatingHours() {
	const now = new Date();
	const formatter = new Intl.DateTimeFormat('en-GB', {
		timeZone: 'Europe/Rome',
		hour: '2-digit',
		hour12: false
	});
	const currentHourItaly = parseInt(formatter.format(now));

	const is_operating = currentHourItaly >= 8 && currentHourItaly < 20;
	if (!is_operating) {
		console.log(`[Operating Hours] Current hour in Italy ${currentHourItaly} is outside operating hours (8-20).`);
	}
	return is_operating;
}

// Helper function to check if a proposed UTC time falls within Italian operating hours (9-20 Rome time)
// This function was moved from outgoing-call.js
export const isWithinItalianOperatingHours = (utcDate) => {
	const formatter = new Intl.DateTimeFormat('en-GB', {
		timeZone: 'Europe/Rome',
		hour: '2-digit',
		hour12: false // 24-hour format
	});
	const hourInItaly = parseInt(formatter.format(utcDate));
	return hourInItaly >= 9 && hourInItaly < 20;
};

// Helper function to convert an Italian local date and time string to a UTC Date object
export function italianLocalToUTC(dateStr, timeStr, timeZone = 'Europe/Rome') {
	const [day, month, year] = dateStr.split('-').map(Number);
	const [hours, minutes] = timeStr.split(':').map(Number);

	const tempUTCDate = new Date(Date.UTC(year, month - 1, day, hours, minutes));

	const formatter = new Intl.DateTimeFormat('en-GB', {
		timeZone: timeZone,
		hour: '2-digit',
		hour12: false
	});
	const italianHourForTempUTCDate = parseInt(formatter.format(tempUTCDate));

	const offsetInHours = italianHourForTempUTCDate - hours;

	const targetUTCHours = hours - offsetInHours;

	return new Date(Date.UTC(year, month - 1, day, targetUTCHours, minutes));
}

// Helper function to get the next workday (Mon-Fri), operating on UTC dates
export function getNextValidWorkday(date) {
	const nextDay = new Date(date.getTime());
	nextDay.setUTCDate(nextDay.getUTCDate() + 1);
	while (nextDay.getUTCDay() === 0 || nextDay.getUTCDay() === 6) {
		nextDay.setUTCDate(nextDay.getUTCDate() + 1);
	}
	return nextDay;
}

/**
 * Checks if the targetDate is within one week from the startDate.
 * @param {Date} targetDate The date to check.
 * @param {Date} startDate The start of the one-week period.
 * @returns {boolean} True if targetDate is within one week from startDate, false otherwise.
 */
export function isWithinOneWeek(targetDate, startDate) {
	if (!(targetDate instanceof Date) || !(startDate instanceof Date) || isNaN(targetDate.getTime()) || isNaN(startDate.getTime())) {
		console.error("[isWithinOneWeek] Invalid date objects provided.", { targetDate, startDate });
		return false; // Or throw an error, depending on desired behavior
	}
	const oneWeekInMillis = 7 * 24 * 60 * 60 * 1000;
	const endDate = new Date(startDate.getTime() + oneWeekInMillis);
	return targetDate < endDate;
}

/**
 * Parses an Italian datetime string ("DD-MM-YYYY HH:mm") to a UTC Date object.
 * @param {string} dateTimeStr Italian datetime string.
 * @returns {Date|null} UTC Date object or null if parsing fails.
 */
export function parseItalianDateTimeToUTC(dateTimeStr) {
	if (!dateTimeStr || typeof dateTimeStr !== 'string') {
		console.error("[DateTimeParse] Invalid input for parseItalianDateTimeToUTC:", dateTimeStr);
		return null;
	}
	const parts = dateTimeStr.split(' ');
	if (parts.length !== 2) {
		console.error(`[DateTimeParse] Invalid format: "${dateTimeStr}". Expected "DD-MM-YYYY HH:mm".`);
		return null;
	}
	const dateStr = parts[0];
	const timeStr = parts[1];

	if (!/^\d{2}-\d{2}-\d{4}$/.test(dateStr) || !/^\d{2}:\d{2}$/.test(timeStr)) {
		console.error(`[DateTimeParse] Invalid date or time format in "${dateTimeStr}". Date: ${dateStr}, Time: ${timeStr}`);
		return null;
	}
	try {
		return italianLocalToUTC(dateStr, timeStr);
	} catch (e) {
		console.error(`[DateTimeParse] Error converting "${dateTimeStr}" to UTC: ${e.message}`);
		return null;
	}
}

/**
 * Get GoHighLevel userIds that cover a specific province and service
 * @param {string} province - The Italian province name
 * @param {string} service - The service name (Infissi, Vetrate, Pergole)
 * @returns {string[]} Array of userIds that cover this province and service
 */
export async function getUserIdsForProvinceAndService(province, service) {
	// Import here to avoid circular dependencies
	const { PROVINCE_SERVICE_TO_USER_IDS, SERVICE_TO_USER_IDS, INFISSI_VETRATE_AGENT_USER_ID, PERGOLE_AGENT_USER_ID } = await import('./config.js');
	
	if (!province || !service) {
		console.warn('[Province-Service Mapping] Province or service not provided, returning empty array');
		return [];
	}

	// Check if agent userIds are configured
	if (!INFISSI_VETRATE_AGENT_USER_ID && !PERGOLE_AGENT_USER_ID) {
		console.error('[Province-Service Mapping] CRITICAL: Neither INFISSI_VETRATE_AGENT_USER_ID nor PERGOLE_AGENT_USER_ID are configured in environment variables!');
		return [];
	}

	// First try to get userIds for specific province and service
	const provinceServiceMapping = PROVINCE_SERVICE_TO_USER_IDS[province];
	let userIds = [];
	
	if (provinceServiceMapping && provinceServiceMapping[service]) {
		userIds = provinceServiceMapping[service];
		console.log(`[Province-Service Mapping] Found province-specific mapping for ${province} + ${service}: ${userIds.join(', ')}`);
	} else {
		// Fall back to general service mapping
		userIds = SERVICE_TO_USER_IDS[service] || [];
		console.log(`[Province-Service Mapping] Using general service mapping for ${service}: ${userIds.join(', ')}`);
		
		if (userIds.length === 0) {
			console.warn(`[Province-Service Mapping] No userIds found for service: ${service}. Available services: ${Object.keys(SERVICE_TO_USER_IDS).join(', ')}`);
		}
	}

	// Filter out empty userIds (in case one of the agents isn't configured)
	const validUserIds = userIds.filter(userId => userId && userId.trim() !== '');
	
	if (validUserIds.length === 0) {
		console.error(`[Province-Service Mapping] No valid userIds configured for province ${province} and service ${service}. Please check INFISSI_VETRATE_AGENT_USER_ID and PERGOLE_AGENT_USER_ID environment variables.`);
		return [];
	}

	if (validUserIds.length < userIds.length) {
		console.warn(`[Province-Service Mapping] Some userIds are empty for province ${province} and service ${service}. Using ${validUserIds.length} out of ${userIds.length} configured agents.`);
	}

	console.log(`[Province-Service Mapping] Found ${validUserIds.length} agent(s) for province ${province} and service ${service}: ${validUserIds.join(', ')}`);
	return validUserIds;
}

/**
 * Get GoHighLevel userIds that cover a specific province (backwards compatibility)
 * @param {string} province - The Italian province name
 * @returns {string[]} Array of userIds that cover this province
 */
export async function getUserIdsForProvince(province) {
	console.warn('[Province Mapping] getUserIdsForProvince is deprecated. Use getUserIdsForProvinceAndService instead.');
	
	// Import here to avoid circular dependencies
	const { INFISSI_VETRATE_AGENT_USER_ID, PERGOLE_AGENT_USER_ID } = await import('./config.js');
	
	if (!province) {
		console.warn('[Province Mapping] No province provided, returning empty array');
		return [];
	}

	// Check if agent userIds are configured
	if (!INFISSI_VETRATE_AGENT_USER_ID && !PERGOLE_AGENT_USER_ID) {
		console.error('[Province Mapping] CRITICAL: Neither INFISSI_VETRATE_AGENT_USER_ID nor PERGOLE_AGENT_USER_ID are configured in environment variables!');
		return [];
	}

	// Return both agents for backwards compatibility
	const allUserIds = [INFISSI_VETRATE_AGENT_USER_ID, PERGOLE_AGENT_USER_ID];
	const validUserIds = allUserIds.filter(userId => userId && userId.trim() !== '');
	
	console.log(`[Province Mapping] Found ${validUserIds.length} agent(s) for province ${province}: ${validUserIds.join(', ')}`);
	return validUserIds;
}

/**
 * Extract province from contact information
 * This function tries to extract province from various contact fields
 * @param {Object} contactData - Contact information object
 * @returns {string|null} Province name or null if not found
 */
export async function extractProvinceFromContact(contactData) {
	if (!contactData) {
		return null;
	}

	// Check various possible fields where province might be stored
	const possibleProvinceFields = [
		'province',
		'provincia',
		'city',
		'citta',
		'location',
		'address',
		'indirizzo'
	];

	for (const field of possibleProvinceFields) {
		if (contactData[field]) {
			const fieldValue = contactData[field].toString().trim();
			
			// Try to extract province using the new function
			const extractedProvince = await extractProvinceFromAddress(fieldValue);
			if (extractedProvince) {
				console.log(`[Province Extraction] Found province: ${extractedProvince} from field ${field} (value: ${fieldValue})`);
				return extractedProvince;
			}
		}
	}

	console.warn(`[Province Extraction] Could not extract province from contact data:`, contactData);
	return null;
}

/**
 * Fetch ZIP code to province mapping from Google Sheets
 * Uses caching to avoid repeated API calls
 * @returns {Map} Map of ZIP codes to province codes
 */
async function fetchZipCodeProvinceMapping() {
	// Check if cache is still valid
	if (zipCodeProvinceCache.size > 0 && cacheLastUpdated && 
		(Date.now() - cacheLastUpdated) < CACHE_DURATION_MS) {
		console.log(`[Google Sheets] Using cached ZIP code data (${zipCodeProvinceCache.size} entries)`);
		return zipCodeProvinceCache;
	}

	try {
		console.log('[Google Sheets] Fetching ZIP code to province mapping...');
		
		// Load service account credentials
		const credentials = JSON.parse(await import('fs').then(fs => 
			fs.promises.readFile('./ai-infrastructures-a68aae67f1b1.json', 'utf8')
		));

		// Initialize Google Sheets API
		const auth = new google.auth.GoogleAuth({
			credentials,
			scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
		});

		const sheets = google.sheets({ version: 'v4', auth });

		// Fetch data from the spreadsheet
		const response = await sheets.spreadsheets.values.get({
			spreadsheetId: GOOGLE_SHEETS_ID,
			range: GOOGLE_SHEETS_RANGE,
		});

		const rows = response.data.values;
		if (!rows || rows.length === 0) {
			console.warn('[Google Sheets] No data found in spreadsheet');
			return zipCodeProvinceCache;
		}

		// Clear existing cache
		zipCodeProvinceCache.clear();

		// Process rows (skip header row)
		let processedCount = 0;
		for (let i = 1; i < rows.length; i++) {
			const row = rows[i];
			if (row.length >= 3) {
				const comune = row[0]; // Column A - COMUNE
				const cap = row[1];    // Column B - CAP
				const provincia = row[2]; // Column C - PROVINCIA

				// Validate and clean the data
				if (cap && provincia && typeof cap === 'string' && typeof provincia === 'string') {
					const cleanCap = cap.trim();
					const cleanProvincia = provincia.trim().toUpperCase();
					
					// Italian ZIP codes should be 5 digits
					if (/^\d{5}$/.test(cleanCap) && cleanProvincia.length === 2) {
						zipCodeProvinceCache.set(cleanCap, cleanProvincia);
						processedCount++;
					}
				}
			}
		}

		cacheLastUpdated = Date.now();
		console.log(`[Google Sheets] Successfully loaded ${processedCount} ZIP code mappings from Google Sheets`);
		
		return zipCodeProvinceCache;

	} catch (error) {
		console.error('[Google Sheets] Error fetching ZIP code data:', error.message);
		
		// If we have cached data, use it even if it's old
		if (zipCodeProvinceCache.size > 0) {
			console.log(`[Google Sheets] Using stale cached data (${zipCodeProvinceCache.size} entries)`);
			return zipCodeProvinceCache;
		}
		
		// Return empty map if no cache and fetch failed
		return new Map();
	}
}

/**
 * Extract province from ZIP code using Google Sheets data
 * @param {string} address - The address string to parse for ZIP codes
 * @returns {string|null} Province code or null if not found
 */
async function extractProvinceFromZipCode(address) {
	if (!address || typeof address !== 'string') {
		return null;
	}

	// Extract 5-digit ZIP codes from the address
	const zipCodeMatches = address.match(/\b(\d{5})\b/g);
	if (!zipCodeMatches || zipCodeMatches.length === 0) {
		return null;
	}

	try {
		// Get the ZIP code to province mapping
		const zipCodeMapping = await fetchZipCodeProvinceMapping();
		
		// Try each ZIP code found in the address
		for (const zipCode of zipCodeMatches) {
			const province = zipCodeMapping.get(zipCode);
			if (province) {
				console.log(`[Google Sheets] Found province ${province} for ZIP code ${zipCode}`);
				return province;
			}
		}

		console.log(`[Google Sheets] No province found for ZIP codes: ${zipCodeMatches.join(', ')}`);
		return null;

	} catch (error) {
		console.error('[Google Sheets] Error during ZIP code lookup:', error.message);
		return null;
	}
}

/**
 * Extract Italian province code from an address string using 3 strategies
 * @param {string} address - The address string to parse
 * @returns {string|null} Province code (e.g., "RM", "MI") or null if not found
 */
export async function extractProvinceFromAddress(address) {
	if (!address || typeof address !== 'string') {
		return null;
	}

	console.log(`[Province Extraction] Processing address: "${address}"`);

	// Check if this is a placeholder/default address that we should skip
	const placeholderPatterns = [
		/follow-up call.*(address tbd|address to be determined)/i,
		/follow-up call\s*-\s*address tbd/i,
		/address tbd/i,
		/to be determined/i,
		/placeholder/i
	];

	for (const pattern of placeholderPatterns) {
		if (pattern.test(address)) {
			console.log(`[Province Extraction] Skipping placeholder address: "${address}"`);
			return null;
		}
	}

	// Strategy 1: Try direct province code extraction first (fastest and most reliable)
	const directCode = extractDirectProvinceCode(address);
	if (directCode) {
		console.log(`[Province Extraction] Found direct province code: ${directCode}`);
		return directCode;
	}

	// Strategy 2: Try ZIP code lookup via Google Sheets (very accurate for Italian addresses)
	try {
		const zipCodeProvince = await extractProvinceFromZipCode(address);
		if (zipCodeProvince) {
			console.log(`[Province Extraction] Found province via Google Sheets ZIP code lookup: ${zipCodeProvince}`);
			return zipCodeProvince;
		}
	} catch (error) {
		console.warn(`[Province Extraction] Google Sheets ZIP code lookup failed: ${error.message}`);
	}

	// Strategy 3: Fallback to Gemini AI
	const geminiProvince = await extractProvinceViaGemini(address);
	if (geminiProvince) {
		console.log(`[Province Extraction] Found province via Gemini AI: ${geminiProvince}`);
		return geminiProvince;
	}

	console.warn(`[Province Extraction] All 3 methods failed to extract province from address: "${address}"`);
	return null;
}

/**
 * Extract direct province codes from address (2-letter codes)
 */
function extractDirectProvinceCode(address) {
	const addressUpper = address.toUpperCase();
	const validProvinceCodes = [
		'AG', 'AL', 'AN', 'AO', 'AR', 'AP', 'AT', 'AV', 'BA', 'BT', 'BL', 'BN', 'BG', 'BI', 'BO', 'BZ', 'BS', 'BR',
		'CA', 'CL', 'CB', 'CI', 'CE', 'CT', 'CZ', 'CH', 'CO', 'CS', 'CR', 'KR', 'CN', 'EN', 'FM', 'FE', 'FI', 'FG',
		'FC', 'FR', 'GE', 'GO', 'GR', 'IM', 'IS', 'SP', 'AQ', 'LT', 'LE', 'LC', 'LI', 'LO', 'LU', 'MC', 'MN', 'MS',
		'MT', 'VS', 'ME', 'MI', 'MO', 'MB', 'NA', 'NO', 'NU', 'OG', 'OT', 'OR', 'PD', 'PA', 'PR', 'PV', 'PG', 'PU',
		'PE', 'PC', 'PI', 'PT', 'PN', 'PZ', 'PO', 'RG', 'RA', 'RC', 'RE', 'RI', 'RN', 'RM', 'RO', 'SA', 'SS', 'SV',
		'SI', 'SO', 'SR', 'TA', 'TE', 'TR', 'TO', 'TP', 'TN', 'TV', 'TS', 'UD', 'VA', 'VE', 'VB', 'VC', 'VR', 'VV', 'VI', 'VT'
	];

	// Look for province codes with word boundaries
	const provinceCodeMatch = addressUpper.match(/\b([A-Z]{2})\b/g);
	if (provinceCodeMatch) {
		for (const code of provinceCodeMatch) {
			if (validProvinceCodes.includes(code)) {
				return code;
			}
		}
	}

	return null;
}





/**
 * Fallback to extract province using Gemini AI
 * @param {string} address - The full address string.
 * @returns {string|null} The two-letter province code or null.
 */
async function extractProvinceViaGemini(address) {
	if (!GEMINI_API_KEY) {
		console.warn('[GEMINI] GEMINI_API_KEY is not configured. Skipping Gemini fallback.');
		return null;
	}
	if (!address) {
		return null;
	}

	console.log(`[GEMINI] Using Gemini to extract province from address: "${address}"`);

	try {
		const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
		const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

		const prompt = `Extract the Italian province code from this address. Return ONLY the 2-letter province code (like RM, MI, NA, TO, etc.). No explanations, no punctuation, just the code.

Address: "${address}"

Province code:`;

		const result = await model.generateContent({
			contents: [{ role: "user", parts: [{ text: prompt }] }],
			generationConfig: {
				temperature: 0.1,
				maxOutputTokens: 10,
				candidateCount: 1,
			},
		});

		const response = result.response;
		const text = response.text().trim().toUpperCase();

		// Extract 2-letter code from response (in case there's extra text)
		const provinceMatch = text.match(/\b([A-Z]{2})\b/);
		if (provinceMatch) {
			const provinceCode = provinceMatch[1];
			// Validate against known Italian province codes
			const validCodes = [
				'AG', 'AL', 'AN', 'AO', 'AR', 'AP', 'AT', 'AV', 'BA', 'BT', 'BL', 'BN', 'BG', 'BI', 'BO', 'BZ', 'BS', 'BR',
				'CA', 'CL', 'CB', 'CI', 'CE', 'CT', 'CZ', 'CH', 'CO', 'CS', 'CR', 'KR', 'CN', 'EN', 'FM', 'FE', 'FI', 'FG',
				'FC', 'FR', 'GE', 'GO', 'GR', 'IM', 'IS', 'SP', 'AQ', 'LT', 'LE', 'LC', 'LI', 'LO', 'LU', 'MC', 'MN', 'MS',
				'MT', 'VS', 'ME', 'MI', 'MO', 'MB', 'NA', 'NO', 'NU', 'OG', 'OT', 'OR', 'PD', 'PA', 'PR', 'PV', 'PG', 'PU',
				'PE', 'PC', 'PI', 'PT', 'PN', 'PZ', 'PO', 'RG', 'RA', 'RC', 'RE', 'RI', 'RN', 'RM', 'RO', 'SA', 'SS', 'SV',
				'SI', 'SO', 'SR', 'TA', 'TE', 'TR', 'TO', 'TP', 'TN', 'TV', 'TS', 'UD', 'VA', 'VE', 'VB', 'VC', 'VR', 'VV', 'VI', 'VT'
			];
			
			if (validCodes.includes(provinceCode)) {
				console.log(`[GEMINI] Successfully extracted province code: ${provinceCode}`);
				return provinceCode;
			}
		}

		console.warn(`[GEMINI] Gemini returned an invalid or unrecognized response: "${text}"`);
		return null;
	} catch (error) {
		console.error('[GEMINI] Error during Gemini API call:', error);
		return null;
	}
}

/**
 * Extract province from Italian postal codes
 */
function extractProvinceFromPostalCode(address) {
	// Italian postal codes are 5 digits
	const postalCodeMatch = address.match(/\b(\d{5})\b/);
	if (!postalCodeMatch) {
		return null;
	}
	
	const postalCode = postalCodeMatch[1];
	const firstTwoDigitsStr = postalCode.substring(0, 2);
	
	// Italian postal code to province mapping (simplified)
	const postalCodeToProvince = {
		// Rome area
		'00': 'RM',
		// Milan area  
		'20': 'MI',
		// Naples area
		'80': 'NA', '81': 'NA',
		// Turin area
		'10': 'TO',
		// Palermo area
		'90': 'PA',
		// Genoa area
		'16': 'GE',
		// Bologna area
		'40': 'BO',
		// Florence area
		'50': 'FI',
		// Bari area
		'70': 'BA',
		// Catania area
		'95': 'CT',
		// Venice area
		'30': 'VE',
		// Verona area
		'37': 'VR',
		// Add more mappings as needed
	};
	
	const province = postalCodeToProvince[firstTwoDigitsStr];
	if (province) {
		console.log(`[Province Extraction] Found province ${province} from postal code ${postalCode}`);
		return province;
	}
	
	return null;
}



/**
 * Parse a slot string that may contain userId information
 * Format: "14:30|userId" or just "14:30"
 * @param {string} slotString - The slot string to parse
 * @returns {Object} Object with time and userId properties
 */
export function parseSlotWithUserId(slotString) {
	if (!slotString || typeof slotString !== 'string') {
		return { time: null, userId: null };
	}

	const parts = slotString.split('|');
	return {
		time: parts[0] || null,
		userId: parts[1] || null
	};
}

/**
 * Extract userId from a datetime string that was formatted for the AI
 * This parses the available slots text to find the userId for a specific time
 * @param {string} slotsText - The formatted slots text
 * @param {string} targetDatetime - The datetime string to find the userId for
 * @returns {string|null} The userId or null if not found
 */
export function extractUserIdFromSlotsText(slotsText, targetDatetime) {
	if (!slotsText || !targetDatetime) {
		return null;
	}

	try {
		// Parse the target datetime to get date and time components
		const targetDate = new Date(targetDatetime);
		const targetTime = targetDate.toLocaleTimeString('it-IT', { 
			hour: '2-digit', 
			minute: '2-digit', 
			timeZone: 'Europe/Rome'
		});

		// Split slots text by lines to find the relevant date
		const lines = slotsText.split('\\n');
		
		for (const line of lines) {
			if (line.includes(targetTime)) {
				// Find the specific time slot in this line
				const timeSlotsMatch = line.match(/:\s*(.+)$/);
				if (timeSlotsMatch) {
					const timeSlots = timeSlotsMatch[1].split(', ');
					
					for (const slot of timeSlots) {
						const parsed = parseSlotWithUserId(slot.trim());
						if (parsed.time === targetTime && parsed.userId) {
							console.log(`[Slot Parser] Found userId ${parsed.userId} for time ${targetTime}`);
							return parsed.userId;
						}
					}
				}
			}
		}

		console.warn(`[Slot Parser] Could not find userId for datetime ${targetDatetime} (time: ${targetTime})`);
		return null;
	} catch (error) {
		console.error(`[Slot Parser] Error parsing userId from slots text:`, error);
		return null;
	}
}

/**
 * Create a clean slots text for AI consumption (without userId information)
 * @param {string} slotsText - The original slots text with userId information
 * @returns {string} Clean slots text without userId information
 */
export function createCleanSlotsTextForAI(slotsText) {
	if (!slotsText) {
		return slotsText;
	}

	try {
		// Remove userId information from time slots
		return slotsText.replace(/(\d{2}:\d{2})\|[^,\s]+/g, '$1');
	} catch (error) {
		console.error(`[Slot Parser] Error cleaning slots text:`, error);
		return slotsText;
	}
}