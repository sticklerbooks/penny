import twilio from 'twilio'

let _client: twilio.Twilio | null = null

function getTwilio(): twilio.Twilio {
  if (!_client) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID
    if (!accountSid) throw new Error('TWILIO_ACCOUNT_SID not configured')

    const apiKey = process.env.TWILIO_API_KEY
    const apiSecret = process.env.TWILIO_API_SECRET

    if (apiKey && apiSecret) {
      // Preferred: API key auth (revocable, better for production)
      _client = twilio(apiKey, apiSecret, { accountSid })
    } else {
      // Fallback: Auth token (still works, just less ideal)
      const authToken = process.env.TWILIO_AUTH_TOKEN
      if (!authToken) throw new Error('Neither TWILIO_API_KEY/SECRET nor TWILIO_AUTH_TOKEN configured')
      _client = twilio(accountSid, authToken)
    }
  }
  return _client
}

export async function sendSMS(message: string): Promise<void> {
  const from = process.env.TWILIO_FROM_NUMBER
  const to = process.env.ADAM_PHONE_NUMBER
  if (!from || !to) throw new Error('Twilio phone numbers not configured')

  await getTwilio().messages.create({ body: message, from, to })
}
