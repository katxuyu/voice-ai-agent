import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendNonFatalSlackNotification } from './slack/notifications.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = process.env.SQLITE_DB_PATH || path.join(__dirname, 'database.db'); // Use env var or default

// Function to open DB connection
export function openDb() {
	return new Promise((resolve, reject) => {
		// Use verbose mode for more detailed errors during development
		const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
					if (err) {
			console.error('[DB] Error opening database', err.message);
			// Import and send Slack notification for database connection errors
			import('./slack/notifications.js').then(({ sendNonFatalSlackNotification }) => {
				sendNonFatalSlackNotification(
					'Database Connection Error',
					`Failed to open database connection`,
					{
						error: err.message,
						stack: err.stack,
						dbPath: DB_PATH,
						function: 'openDb'
					}
				).catch(console.error);
			}).catch(console.error);
			reject(err);
		} else {
				// console.log('[DB] Database connected.'); // Optional: log connection
				resolve(db);
			}
		});
	});
}

// Function to close DB connection
export function closeDb(db) {
	return new Promise((resolve, reject) => {
		if (db) {
			db.close((err) => {
				if (err) {
					console.error('[DB] Error closing database', err.message);
					reject(err);
				} else {
					// console.log('[DB] Database connection closed.'); // Optional: log close
					resolve();
				}
			});
		} else {
			resolve(); // No db instance to close
		}
	});
}

// Promisify db.run, db.get, db.all
export function run(db, sql, params = []) {
	return new Promise((resolve, reject) => {
		db.run(sql, params, function (err) { // Use function() to access this.lastID, this.changes
			if (err) {
				console.error('[DB] Error running sql: ', sql);
				console.error('[DB] Params: ', params);
				console.error('[DB] Error: ', err);
				// Send Slack notification for critical database operations
				sendNonFatalSlackNotification(
					'Database SQL Execution Error',
					`Failed to execute SQL query in db.run`,
					{
						sql: sql.substring(0, 200),
						params: JSON.stringify(params).substring(0, 200),
						error: err.message,
						stack: err.stack,
						function: 'db.run'
					}
				).catch(console.error);
				reject(err);
			} else {
				resolve({ lastID: this.lastID, changes: this.changes });
			}
		});
	});
}

export function get(db, sql, params = []) {
	return new Promise((resolve, reject) => {
		db.get(sql, params, (err, result) => {
			if (err) {
				console.error('[DB] Error running sql: ', sql);
				console.error('[DB] Params: ', params);
				console.error('[DB] Error: ', err);
				reject(err);
			} else {
				resolve(result); // result will be undefined if no row is found
			}
		});
	});
}

export function all(db, sql, params = []) {
	return new Promise((resolve, reject) => {
		db.all(sql, params, (err, rows) => {
			if (err) {
				console.error('[DB] Error running sql: ', sql);
				console.error('[DB] Params: ', params);
				console.error('[DB] Error: ', err);
				reject(err);
			} else {
				resolve(rows);
			}
		});
	});
}

// Ensure the table exists
export async function initializeDatabase() {
	let db;
	try {
		console.log("[DB] Initializing database...");
		db = await openDb();
		// Use location_id as the primary key to ensure uniqueness per location
		await run(db, `CREATE TABLE IF NOT EXISTS gohighlevel_tokens (
			location_id TEXT PRIMARY KEY NOT NULL,
			access_token TEXT NOT NULL,
			refresh_token TEXT NOT NULL,
			expires_at TEXT,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`);
		console.log("[DB] gohighlevel_tokens table checked/created successfully (location_id as PRIMARY KEY).");

		// New table for follow-ups
		await run(db, `CREATE TABLE IF NOT EXISTS follow_ups (
			follow_up_id INTEGER PRIMARY KEY AUTOINCREMENT,
			contact_id TEXT NOT NULL,
			follow_up_at_utc TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			status TEXT DEFAULT 'pending'
		)`);
		console.log("[DB] follow_ups table checked/created successfully.");

		// Check and add missing columns to follow_ups table if they don't exist
		const followUpsTableInfoRows = await all(db, "PRAGMA table_info(follow_ups)");
		let foundContactIdInFollowUps = false;
		let foundStatusInFollowUps = false;
		let foundProvinceInFollowUps = false;
		let foundServiceInFollowUps = false;
		if (followUpsTableInfoRows && followUpsTableInfoRows.length > 0) {
			foundContactIdInFollowUps = followUpsTableInfoRows.some(column => column && column.name === 'contact_id');
			foundStatusInFollowUps = followUpsTableInfoRows.some(column => column && column.name === 'status');
			foundProvinceInFollowUps = followUpsTableInfoRows.some(column => column && column.name === 'province');
			foundServiceInFollowUps = followUpsTableInfoRows.some(column => column && column.name === 'service');
		}

		if (!foundContactIdInFollowUps) {
			console.log("[DB] Column 'contact_id' not found in 'follow_ups'. Adding it...");
			try {
				await run(db, "ALTER TABLE follow_ups ADD COLUMN contact_id TEXT NOT NULL DEFAULT ''");
				console.log("[DB] Column 'contact_id' added to 'follow_ups' successfully.");
			} catch (error) {
				console.error("[DB] Error adding contact_id column:", error);
				// If the column addition fails, it might be due to existing data or constraints
				// Log the error but don't fail the entire initialization
			}
		} else {
			console.log("[DB] Column 'contact_id' already exists in 'follow_ups'.");
		}

		if (!foundStatusInFollowUps) {
			console.log("[DB] Column 'status' not found in 'follow_ups'. Adding it...");
			try {
				await run(db, "ALTER TABLE follow_ups ADD COLUMN status TEXT DEFAULT 'pending'");
				console.log("[DB] Column 'status' added to 'follow_ups' successfully.");
			} catch (error) {
				console.error("[DB] Error adding status column:", error);
				// If the column addition fails, log the error but don't fail the entire initialization
			}
		} else {
			console.log("[DB] Column 'status' already exists in 'follow_ups'.");
		}

		if (!foundProvinceInFollowUps) {
			console.log("[DB] Column 'province' not found in 'follow_ups'. Adding it...");
			try {
				await run(db, "ALTER TABLE follow_ups ADD COLUMN province TEXT");
				console.log("[DB] Column 'province' added to 'follow_ups' successfully.");
			} catch (error) {
				console.error("[DB] Error adding province column:", error);
			}
		} else {
			console.log("[DB] Column 'province' already exists in 'follow_ups'.");
		}

		if (!foundServiceInFollowUps) {
			console.log("[DB] Column 'service' not found in 'follow_ups'. Adding it...");
			try {
				await run(db, "ALTER TABLE follow_ups ADD COLUMN service TEXT");
				console.log("[DB] Column 'service' added to 'follow_ups' successfully.");
			} catch (error) {
				console.error("[DB] Error adding service column:", error);
			}
		} else {
			console.log("[DB] Column 'service' already exists in 'follow_ups'.");
		}

		// New table for calls (replacing Firebase)
		await run(db, `CREATE TABLE IF NOT EXISTS calls (
			callSid TEXT PRIMARY KEY NOT NULL,
			"to" TEXT,
			contactId TEXT,
			retry_count INTEGER DEFAULT 0,
			status TEXT,
			created_at TEXT,
			signedUrl TEXT,
			fullName TEXT,
			firstName TEXT,
			email TEXT,
			answeredBy TEXT,
			availableSlots TEXT,
			conversationId TEXT,
			first_attempt_timestamp DATETIME,
			service TEXT
		)`);
		console.log("[DB] calls table checked/created successfully.");

		// Check and add missing columns to calls table if they don't exist
		const callsTableInfoRows = await all(db, "PRAGMA table_info(calls)");
		let foundFirstAttemptTimestampInCalls = false;
		let foundServiceInCalls = false;
		let foundRetryScheduledInCalls = false;
		let foundProvinceInCalls = false;
		let foundStreamSidInCalls = false;
		if (callsTableInfoRows && callsTableInfoRows.length > 0) {
			foundFirstAttemptTimestampInCalls = callsTableInfoRows.some(column => column && column.name === 'first_attempt_timestamp');
			foundServiceInCalls = callsTableInfoRows.some(column => column && column.name === 'service');
			foundRetryScheduledInCalls = callsTableInfoRows.some(column => column && column.name === 'retry_scheduled');
			foundProvinceInCalls = callsTableInfoRows.some(column => column && column.name === 'province');
			foundStreamSidInCalls = callsTableInfoRows.some(column => column && column.name === 'streamSid');
		}

		if (!foundFirstAttemptTimestampInCalls) {
			console.log("[DB] Column 'first_attempt_timestamp' not found in 'calls'. Adding it...");
			try {
				await run(db, "ALTER TABLE calls ADD COLUMN first_attempt_timestamp DATETIME");
				console.log("[DB] Column 'first_attempt_timestamp' added to 'calls' successfully.");
			} catch (error) {
				if (error.message.includes('duplicate column name')) {
					console.log("[DB] Column 'first_attempt_timestamp' already exists in 'calls' (detected during add attempt).");
				} else {
					console.error("[DB] Error adding first_attempt_timestamp column:", error);
				}
			}
		} else {
			console.log("[DB] Column 'first_attempt_timestamp' already exists in 'calls'.");
		}

		if (!foundServiceInCalls) {
			console.log("[DB] Column 'service' not found in 'calls'. Adding it...");
			try {
				await run(db, "ALTER TABLE calls ADD COLUMN service TEXT");
				console.log("[DB] Column 'service' added to 'calls' successfully.");
			} catch (error) {
				if (error.message.includes('duplicate column name')) {
					console.log("[DB] Column 'service' already exists in 'calls' (detected during add attempt).");
				} else {
					console.error("[DB] Error adding service column:", error);
				}
			}
		} else {
			console.log("[DB] Column 'service' already exists in 'calls'.");
		}

		if (!foundRetryScheduledInCalls) {
			console.log("[DB] Column 'retry_scheduled' not found in 'calls'. Adding it...");
			try {
				await run(db, "ALTER TABLE calls ADD COLUMN retry_scheduled INTEGER DEFAULT 0");
				console.log("[DB] Column 'retry_scheduled' added to 'calls' successfully.");
			} catch (error) {
				if (error.message.includes('duplicate column name')) {
					console.log("[DB] Column 'retry_scheduled' already exists in 'calls' (detected during add attempt).");
				} else {
					console.error("[DB] Error adding retry_scheduled column:", error);
				}
			}
		} else {
			console.log("[DB] Column 'retry_scheduled' already exists in 'calls'.");
		}

		if (!foundProvinceInCalls) {
			console.log("[DB] Column 'province' not found in 'calls'. Adding it...");
			try {
				await run(db, "ALTER TABLE calls ADD COLUMN province TEXT");
				console.log("[DB] Column 'province' added to 'calls' successfully.");
			} catch (error) {
				if (error.message.includes('duplicate column name')) {
					console.log("[DB] Column 'province' already exists in 'calls' (detected during add attempt).");
				} else {
					console.error("[DB] Error adding province column:", error);
				}
			}
		} else {
			console.log("[DB] Column 'province' already exists in 'calls'.");
		}

		if (!foundStreamSidInCalls) {
			console.log("[DB] Column 'streamSid' not found in 'calls'. Adding it...");
			try {
				await run(db, "ALTER TABLE calls ADD COLUMN streamSid TEXT");
				console.log("[DB] Column 'streamSid' added to 'calls' successfully.");
			} catch (error) {
				if (error.message.includes('duplicate column name')) {
					console.log("[DB] Column 'streamSid' already exists in 'calls' (detected during add attempt).");
				} else {
					console.error("[DB] Error adding streamSid column:", error);
				}
			}
		} else {
			console.log("[DB] Column 'streamSid' already exists in 'calls'.");
		}

		// New table for incoming calls
		await run(db, `CREATE TABLE IF NOT EXISTS incoming_calls (
			callSid TEXT PRIMARY KEY NOT NULL,
			caller_number TEXT,
			callee_number TEXT,
			status TEXT,
			created_at TEXT,
			signedUrl TEXT,
			availableSlots TEXT,
			conversationId TEXT
		)`);
		console.log("[DB] incoming_calls table checked/created successfully (before twilioCallSid check).");

		// Check and add twilioCallSid to incoming_calls if it doesn't exist
		const incomingCallsTableInfoRows = await all(db, "PRAGMA table_info(incoming_calls)"); // Changed get to all
		// PRAGMA table_info returns an object if only one row matches, or an array if multiple.
		// Ensure we handle both cases when checking for the column.
		let foundTwilioCallSid = false;
		if (incomingCallsTableInfoRows && incomingCallsTableInfoRows.length > 0) { // Check rows from all
			foundTwilioCallSid = incomingCallsTableInfoRows.some(column => column && column.name === 'twilioCallSid');
		}

		if (!foundTwilioCallSid) {
			console.log("[DB] Column 'twilioCallSid' not found in 'incoming_calls'. Adding it...");
			try {
				await run(db, "ALTER TABLE incoming_calls ADD COLUMN twilioCallSid TEXT");
				console.log("[DB] Column 'twilioCallSid' added to 'incoming_calls' successfully.");
			} catch (error) {
				if (error.message.includes('duplicate column name')) {
					console.log("[DB] Column 'twilioCallSid' already exists in 'incoming_calls' (detected during add attempt).");
				} else {
					console.error("[DB] Error adding twilioCallSid column:", error);
				}
			}
		} else {
			console.log("[DB] Column 'twilioCallSid' already exists in 'incoming_calls'.");
		}



		// New table for Slack installation tokens
		await run(db, `CREATE TABLE IF NOT EXISTS slack_installation_tokens (
			team_id TEXT PRIMARY KEY NOT NULL,
			app_id TEXT,
			bot_user_id TEXT,
			bot_access_token TEXT NOT NULL,
			bot_scope TEXT,
			token_type TEXT, -- e.g., 'bot'
			enterprise_id TEXT,
			authed_user_id TEXT,
			is_enterprise_install BOOLEAN,
			token_details_json TEXT, -- Store the full JSON response from oauth.v2.access
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`);
		console.log("[DB] slack_installation_tokens table checked/created successfully.");

		// New table for sales representatives
		await run(db, `CREATE TABLE IF NOT EXISTS sales_reps (
			rep_id INTEGER PRIMARY KEY AUTOINCREMENT,
			ghl_user_id TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			services TEXT NOT NULL, -- JSON array of services like ["Infissi", "Vetrate"]
			provinces TEXT NOT NULL, -- JSON array of province codes like ["RM", "BO", "MI"]
			active BOOLEAN DEFAULT 1,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`);
		console.log("[DB] sales_reps table checked/created successfully.");

		// New table for the persistent call queue
		await run(db, `CREATE TABLE IF NOT EXISTS call_queue (
			queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
			contact_id TEXT NOT NULL,
			phone_number TEXT NOT NULL,
			first_name TEXT,
			full_name TEXT,
			email TEXT,
			service TEXT,
			retry_stage INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL DEFAULT 'pending', -- pending, processing, failed, completed
			scheduled_at DATETIME NOT NULL, -- When the call should be attempted
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			first_attempt_timestamp DATETIME, -- Timestamp of the very first call attempt in a retry sequence
			last_attempt_at DATETIME,
			last_error TEXT,
			call_options_json TEXT, -- Store Twilio options like URL, timeout etc.
			available_slots_text TEXT, -- Store the formatted string
			initial_signed_url TEXT -- Store the URL generated when enqueuing
		)`);
		console.log("[DB] call_queue table checked/created successfully.");

		// Check and add service and province to call_queue if they don't exist
		const callQueueTableInfoRows = await all(db, "PRAGMA table_info(call_queue)");
		let foundServiceInCallQueue = false;
		let foundProvinceInCallQueue = false;
		if (callQueueTableInfoRows && callQueueTableInfoRows.length > 0) {
			foundServiceInCallQueue = callQueueTableInfoRows.some(column => column && column.name === 'service');
			foundProvinceInCallQueue = callQueueTableInfoRows.some(column => column && column.name === 'province');
		}

		if (!foundServiceInCallQueue) {
			console.log("[DB] Column 'service' not found in 'call_queue'. Adding it...");
			try {
				await run(db, "ALTER TABLE call_queue ADD COLUMN service TEXT");
				console.log("[DB] Column 'service' added to 'call_queue' successfully.");
			} catch (error) {
				if (error.message.includes('duplicate column name')) {
					console.log("[DB] Column 'service' already exists in 'call_queue' (detected during add attempt).");
				} else {
					console.error("[DB] Error adding service column to call_queue:", error);
				}
			}
		} else {
			console.log("[DB] Column 'service' already exists in 'call_queue'.");
		}

		if (!foundProvinceInCallQueue) {
			console.log("[DB] Column 'province' not found in 'call_queue'. Adding it...");
			try {
				await run(db, "ALTER TABLE call_queue ADD COLUMN province TEXT");
				console.log("[DB] Column 'province' added to 'call_queue' successfully.");
			} catch (error) {
				if (error.message.includes('duplicate column name')) {
					console.log("[DB] Column 'province' already exists in 'call_queue' (detected during add attempt).");
				} else {
					console.error("[DB] Error adding province column to call_queue:", error);
				}
			}
		} else {
			console.log("[DB] Column 'province' already exists in 'call_queue'.");
		}

	} catch (error) {
		console.error("[DB] Error initializing database table:", error);
		// Decide if the application should exit if DB init fails
		// process.exit(1);
	} finally {
		await closeDb(db);
	}
}

// Immediately-invoked function expression (IIFE) to set up the database
// and potentially log the path upon initial module load.
(async () => {
	console.log(`Database path: ${DB_PATH}`);
	try {
		await initializeDatabase(); // Ensure tables are created on startup
	} catch (error) {
		console.error("[DB] Error initializing database:", error);
	}
})();

// Helper functions for sales representatives
export async function getSalesRepsByServiceAndProvince(service, province) {
	let db;
	try {
		db = await openDb();
		const reps = await all(db, 
			`SELECT ghl_user_id, name, services, provinces 
			 FROM sales_reps 
			 WHERE active = 1`,
			[]
		);
		
		// Filter reps that handle the specified service and province
		const matchingReps = reps.filter(rep => {
			try {
				const repServices = JSON.parse(rep.services);
				const repProvinces = JSON.parse(rep.provinces);
				
				return repServices.includes(service) && repProvinces.includes(province);
			} catch (parseError) {
				console.error(`[DB] Error parsing JSON for rep ${rep.ghl_user_id}:`, parseError);
				return false;
			}
		});
		
		return matchingReps.map(rep => ({
			ghlUserId: rep.ghl_user_id,
			name: rep.name,
			services: JSON.parse(rep.services),
			provinces: JSON.parse(rep.provinces)
		}));
	    } catch (error) {
        console.error('[DB] Error fetching sales reps by service and province:', error);
        import('./slack/notifications.js').then(({ sendNonFatalSlackNotification }) => {
            sendNonFatalSlackNotification(
                'Database Sales Rep Query Error',
                `Failed to fetch sales reps by service and province`,
                {
                    service,
                    province,
                    error: error.message,
                    stack: error.stack,
                    function: 'getSalesRepsByServiceAndProvince'
                }
            ).catch(console.error);
        }).catch(console.error);
        return [];
    } finally {
		if (db) await closeDb(db);
	}
}

export async function addSalesRep(ghlUserId, name, services, provinces) {
	let db;
	try {
		db = await openDb();
		const result = await run(db,
			`INSERT INTO sales_reps (ghl_user_id, name, services, provinces)
			 VALUES (?, ?, ?, ?)`,
			[ghlUserId, name, JSON.stringify(services), JSON.stringify(provinces)]
		);
		console.log(`[DB] Added sales rep ${name} with ID: ${result.lastID}`);
		return result.lastID;
	} catch (error) {
		console.error('[DB] Error adding sales rep:', error);
		throw error;
	} finally {
		if (db) await closeDb(db);
	}
}

export async function getAllSalesReps() {
	let db;
	try {
		db = await openDb();
		const reps = await all(db, 
			`SELECT rep_id, ghl_user_id, name, services, provinces, active, created_at 
			 FROM sales_reps 
			 ORDER BY name`,
			[]
		);
		
		return reps.map(rep => ({
			repId: rep.rep_id,
			ghlUserId: rep.ghl_user_id,
			name: rep.name,
			services: JSON.parse(rep.services),
			provinces: JSON.parse(rep.provinces),
			active: Boolean(rep.active),
			createdAt: rep.created_at
		}));
	} catch (error) {
		console.error('[DB] Error fetching all sales reps:', error);
		return [];
	} finally {
		if (db) await closeDb(db);
	}
}

export async function updateSalesRepStatus(ghlUserId, active) {
	let db;
	try {
		db = await openDb();
		const result = await run(db,
			`UPDATE sales_reps SET active = ?, updated_at = CURRENT_TIMESTAMP WHERE ghl_user_id = ?`,
			[active ? 1 : 0, ghlUserId]
		);
		console.log(`[DB] Updated sales rep ${ghlUserId} status to ${active ? 'active' : 'inactive'}`);
		return result.changes > 0;
	} catch (error) {
		console.error('[DB] Error updating sales rep status:', error);
		throw error;
	} finally {
		if (db) await closeDb(db);
	}
}

export async function clearAllSalesReps() {
	let db;
	try {
		db = await openDb();
		const result = await run(db, `DELETE FROM sales_reps`, []);
		console.log(`[DB] Cleared ${result.changes} sales representatives from database`);
		return result.changes;
	} catch (error) {
		console.error('[DB] Error clearing sales reps:', error);
		throw error;
	} finally {
		if (db) await closeDb(db);
	}
} 