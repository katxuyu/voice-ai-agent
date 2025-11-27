export async function sendNonFatalSlackNotification(errorTitle, errorMessage, details = null) {
	const webhookUrl = process.env.SLACK_WEBHOOK_URL;
	if (!webhookUrl) {
		console.error('[SLACK NOTIFY] SLACK_WEBHOOK_URL not set. Cannot send Slack notification.');
		return;
	}

	const blocks = [
		{
			"type": "header",
			"text": {
				"type": "plain_text",
				"text": `⚠️ Non-Fatal Issue: ${errorTitle}`,
				"emoji": true
			}
		},
		{
			"type": "section",
			"text": {
				"type": "mrkdwn",
				"text": "<!channel> Non-fatal issue detected"
			}
		},
		{
			"type": "section",
			"fields": [
				{
					"type": "mrkdwn",
					"text": `*Timestamp:*\n${new Date().toISOString()}`
				}
			]
		},
		{
			"type": "section",
			"text": {
				"type": "mrkdwn",
				"text": `*Message:*\n${errorMessage}`
			}
		}
	];

	if (details) {
		blocks.push({ "type": "divider" });
		blocks.push({
			"type": "section",
			"text": {
				"type": "mrkdwn",
				"text": `*Details:*\n\`\`\`\n${typeof details === 'string' ? details : JSON.stringify(details, null, 2)}\n\`\`\``
			}
		});
	}

	const payload = { blocks };

	try {
		console.log(`[SLACK NOTIFY] Sending non-fatal notification to Slack: ${errorTitle}`);
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 second timeout

		const response = await fetch(webhookUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		if (!response.ok) {
			const responseBody = await response.text();
			console.error(`[SLACK NOTIFY] Error sending Slack notification: ${response.status} ${response.statusText} - Response: ${responseBody}`);
		} else {
			console.log(`[SLACK NOTIFY] Non-fatal Slack notification sent successfully: ${errorTitle}`);
		}
	} catch (webhookError) {
		if (webhookError.name === 'AbortError') {
			console.error('[SLACK NOTIFY] Slack notification request timed out.');
		} else {
			console.error('[SLACK NOTIFY] Failed to send Slack notification:', webhookError);
		}
	}
}

export async function sendPositiveSlackNotification(title, message, details = null) {
	const webhookUrl = process.env.SLACK_WEBHOOK_URL;
	if (!webhookUrl) {
		console.error('[SLACK NOTIFY] SLACK_WEBHOOK_URL not set. Cannot send Slack notification.');
		return;
	}

	const blocks = [
		{
			"type": "header",
			"text": {
				"type": "plain_text",
				"text": `✅ Success: ${title}`,
				"emoji": true
			}
		},
		{
			"type": "section",
			"fields": [
				{
					"type": "mrkdwn",
					"text": `*Timestamp:*\n${new Date().toISOString()}`
				}
			]
		},
		{
			"type": "section",
			"text": {
				"type": "mrkdwn",
				"text": `*Message:*\n${message}`
			}
		}
	];

	if (details) {
		blocks.push({ "type": "divider" });
		blocks.push({
			"type": "section",
			"text": {
				"type": "mrkdwn",
				"text": `*Details:*\n\`\`\`\n${typeof details === 'string' ? details : JSON.stringify(details, null, 2)}\n\`\`\``
			}
		});
	}

	const payload = { blocks };

	try {
		console.log(`[SLACK NOTIFY] Sending positive notification to Slack: ${title}`);
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 second timeout

		const response = await fetch(webhookUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		if (!response.ok) {
			const responseBody = await response.text();
			console.error(`[SLACK NOTIFY] Error sending Slack notification: ${response.status} ${response.statusText} - Response: ${responseBody}`);
		} else {
			console.log(`[SLACK NOTIFY] Positive Slack notification sent successfully: ${title}`);
		}
	} catch (webhookError) {
		if (webhookError.name === 'AbortError') {
			console.error('[SLACK NOTIFY] Slack notification request timed out.');
		} else {
			console.error('[SLACK NOTIFY] Failed to send Slack notification:', webhookError);
		}
	}
}

export async function sendSlackNotification(error) {
	const webhookUrl = process.env.SLACK_WEBHOOK_URL; // Use Slack webhook URL
	if (!webhookUrl) {
		console.error('SLACK_WEBHOOK_URL not set. Cannot send Slack notification.');
		return;
	}

	// Construct a Slack Block Kit payload for better formatting
	const payload = {
		blocks: [
			{
				"type": "header",
				"text": {
					"type": "plain_text",
					"text": "🚨 Fatal Server Error Occurred",
					"emoji": true
				}
			},
			{
				"type": "section",
				"text": {
					"type": "mrkdwn",
					"text": "<!channel> 🚨 FATAL ERROR - Immediate attention required!"
				}
			},
			{
				"type": "section",
				"fields": [
					{
						"type": "mrkdwn",
						"text": `*Timestamp:*\n${new Date().toISOString()}`
					}
				]
			},
			{
				"type": "section",
				"text": {
					"type": "mrkdwn",
					"text": `*Error Message:*\n${error.message || 'Unknown error'}`
				}
			},
			{
				"type": "divider"
			},
			{
				"type": "section",
				"text": {
					"type": "mrkdwn",
					"text": `*Stack Trace:*\n\`\`\`${error.stack || 'No stack trace available'}\`\`\``
				}
			}
		]
	};

	try {
		console.log(`Sending fatal error notification to Slack: ${error.message}`);
		// Add a timeout to prevent hanging indefinitely
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

		const response = await fetch(webhookUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
			signal: controller.signal, // Pass the abort signal
		});

		clearTimeout(timeoutId); // Clear the timeout if fetch completes

		if (!response.ok) {
			// Log Slack's error response if possible
			const responseBody = await response.text();
			console.error(`Error sending Slack notification: ${response.status} ${response.statusText} - Response: ${responseBody}`);
		} else {
			console.log('Fatal error Slack notification sent successfully.');
		}
	} catch (webhookError) {
		if (webhookError.name === 'AbortError') {
			console.error('Slack notification request timed out after 5 seconds.');
		} else {
			console.error('Failed to send Slack notification:', webhookError);
		}
	}
}

export async function sendNormalSlackNotification(title, message, details = null) {
	const webhookUrl = process.env.SLACK_WEBHOOK_URL;
	if (!webhookUrl) {
		console.error('[SLACK NOTIFY] SLACK_WEBHOOK_URL not set. Cannot send Slack notification.');
		return;
	}

	const blocks = [
		{
			"type": "header",
			"text": {
				"type": "plain_text",
				"text": `⏸️ ${title}`,
				"emoji": true
			}
		},
		{
			"type": "section",
			"fields": [
				{
					"type": "mrkdwn",
					"text": `*Timestamp:*\n${new Date().toISOString()}`
				}
			]
		},
		{
			"type": "section",
			"text": {
				"type": "mrkdwn",
				"text": `*Message:*\n${message}`
			}
		}
	];

	if (details) {
		blocks.push({ "type": "divider" });
		blocks.push({
			"type": "section",
			"text": {
				"type": "mrkdwn",
				"text": `*Details:*\n\`\`\`\n${typeof details === 'string' ? details : JSON.stringify(details, null, 2)}\n\`\`\``
			}
		});
	}

	const payload = { blocks };

	try {
		console.log(`[SLACK NOTIFY] Sending normal notification to Slack: ${title}`);
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 second timeout

		const response = await fetch(webhookUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		if (!response.ok) {
			const responseBody = await response.text();
			console.error(`[SLACK NOTIFY] Error sending Slack notification: ${response.status} ${response.statusText} - Response: ${responseBody}`);
		} else {
			console.log(`[SLACK NOTIFY] Normal Slack notification sent successfully: ${title}`);
		}
	} catch (webhookError) {
		if (webhookError.name === 'AbortError') {
			console.error('[SLACK NOTIFY] Slack notification request timed out.');
		} else {
			console.error('[SLACK NOTIFY] Failed to send Slack notification:', webhookError);
		}
	}
} 