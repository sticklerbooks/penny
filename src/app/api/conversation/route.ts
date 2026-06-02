import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET() {
  const profile = await prisma.profile.findFirst()
  if (!profile) return NextResponse.json(null)

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)

  const lastConversation = await prisma.conversation.findFirst({
    where: {
      profileId: profile.id,
      closed: false,
      createdAt: { gte: oneDayAgo },
    },
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
