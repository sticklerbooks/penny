import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET() {
  const profile = await prisma.profile.findFirst()
  if (!profile) return NextResponse.json(null)

  const lastConversation = await prisma.conversation.findFirst({
    where: { profileId: profile.id },
    orderBy: { createdAt: 'desc' },
    include: {
      messages: {
        orderBy: { createdAt: 'asc' },
        take: 60,
      },
    },
  })

  return NextResponse.json(lastConversation)
}
