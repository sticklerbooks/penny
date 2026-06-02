import { ImageResponse } from 'next/og'

export const size = { width: 192, height: 192 }
export const contentType = 'image/png'

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: 192,
          height: 192,
          borderRadius: 48,
          background: 'linear-gradient(135deg, #F59E0B, #D97706)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <span
          style={{
            color: 'white',
            fontSize: 108,
            fontWeight: 700,
            fontFamily: 'serif',
            lineHeight: 1,
            marginTop: 6,
          }}
        >
          P
        </span>
      </div>
    ),
    { ...size }
  )
}
