import { notFound } from 'next/navigation'
import ModalityAgenda from '@/components/ModalityAgenda'
import { MODALITIES } from '@/lib/modalities'

export const dynamic = 'force-dynamic'

export default async function ModalityDashboardPage({
  params,
}: {
  params: Promise<{ modality: string }>
}) {
  const { modality } = await params
  const found = MODALITIES.find((m) => m.id === modality && !m.disabled)
  if (!found) notFound()
  return <ModalityAgenda modalityId={found.id} />
}
