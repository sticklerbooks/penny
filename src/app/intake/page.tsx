'use client'

import { useRouter } from 'next/navigation'
import ChatInterface from '@/components/ChatInterface'

export default function IntakePage() {
  const router = useRouter()

  return (
    <ChatInterface
      type="intake"
      onIntakeComplete={() => router.push('/chat')}
    />
  )
}
