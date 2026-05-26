import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET() {
  const profile = await prisma.profile.findFirst()
  return NextResponse.json(profile)
}
