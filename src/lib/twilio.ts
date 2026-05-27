import twilio from 'twilio'

let _client: twilio.Twilio | null = null

function getTwilio(): twilio.Twilio {
  if (!_client) {
    const sid = process.env.TWILIO_ACCOUNT_SID
    const token = process.env.TWILIO_AUTH_TOKEN
    if (!sid || !token) throw new Error('Twilio credentials not configured')
    _client = twilio(sid, token)
  }
  return _client
}

export async function sendSMS(message: string): Promise<void> {
  const from = process.env.TWILIO_FROM_NUMBER
  const to = process.env.ADAM_PHONE_NUMBER
  if (!from || !to) throw new Error('Twilio phone numbers not configured')

  await getTwilio().messages.create({ body: message, from, to })
}
