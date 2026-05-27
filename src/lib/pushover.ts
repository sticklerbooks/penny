// Pushover push notification delivery
// Much simpler than SMS — just one authenticated POST.

export async function sendNotification(message: string, title?: string): Promise<void> {
  const token = process.env.PUSHOVER_API_TOKEN
  const user = process.env.PUSHOVER_USER_KEY
  if (!token || !user) throw new Error('Pushover credentials not configured')

  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
      user,
      message,
      title: title ?? 'Penny',
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Pushover error: ${JSON.stringify(err)}`)
  }
}
