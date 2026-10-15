import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"
import { cn } from "../lib/utils"
import { useReleaseStaleInteraction } from "../hooks/useReleaseStaleInteraction"

function TooltipProvider({
  delayDuration = 300,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  // A tooltip is opened by hovering (or focusing) its trigger, and none of that is undone when the
  // window goes away — nor does the window coming back ask first (`useReleaseStaleInteraction`).
  useReleaseStaleInteraction()

  return (
    <TooltipPrimitive.Provider
      delayDuration={delayDuration}
      disableHoverableContent
      {...props}
    />
  )
}

const Tooltip = TooltipPrimitive.Root

/**
 * The trigger, marked so the window-blur reset can find a tooltip the focus is holding open
 * (`useReleaseStaleInteraction`).
 */
const TooltipTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>
>((props, ref) => <TooltipPrimitive.Trigger ref={ref} data-tooltip-trigger="" {...props} />)
TooltipTrigger.displayName = 'TooltipTrigger'

function TooltipContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-tooltip overflow-hidden rounded-[8px] px-2.5 py-1.5 text-xs",
          "dark bg-background/80 backdrop-blur-xl backdrop-saturate-150 border border-border/50 text-foreground shadow-modal-small",
          "animate-in fade-in-0 duration-100 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-75",
          className
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
