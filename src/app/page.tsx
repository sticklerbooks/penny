import { redirect } from 'next/navigation'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const profile = await prisma.profile.findFirst()

  if (profile?.intakeComplete) {
    redirect('/chat')
  } else {
    redirect('/intake')
  }
}
