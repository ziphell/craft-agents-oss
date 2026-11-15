/**
 * A clip or a recording, opened full-screen from a file link.
 *
 * The same chrome as every other preview (the path badge already offers "Open" and "Reveal in
 * folder"), and the file is served rather than inlined so the player can seek. Chromium decides
 * what it can decode; a container it cannot still shows the player and its error instead of
 * silently sending the person to another window.
 */

import { FileAudio, Video } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { PreviewOverlay } from '@craft-agent/ui'
import { mediaUrl } from '@/lib/media-url'

export function MediaPreviewOverlay({
  isOpen,
  onClose,
  filePath,
  kind,
}: {
  isOpen: boolean
  onClose: () => void
  filePath: string
  kind: 'video' | 'audio'
}) {
  const { t } = useTranslation()

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      typeBadge={{
        icon: kind === 'video' ? Video : FileAudio,
        label: t(kind === 'video' ? 'library.video' : 'library.audio'),
        variant: 'blue',
      }}
      filePath={filePath}
    >
      {kind === 'video' ? (
        <div className="flex min-h-full items-center justify-center p-4">
          <video
            key={filePath}
            src={mediaUrl(filePath)}
            controls
            autoPlay
            playsInline
            className="max-h-[calc(100vh-12rem)] max-w-full rounded-md bg-black"
          />
        </div>
      ) : (
        <div className="flex min-h-full flex-col items-center justify-center gap-6 p-8">
          <FileAudio className="h-12 w-12 text-muted-foreground/30" />
          <audio key={filePath} src={mediaUrl(filePath)} controls className="w-full max-w-lg" />
        </div>
      )}
    </PreviewOverlay>
  )
}
