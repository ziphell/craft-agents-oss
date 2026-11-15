/**
 * 花字, as data — a small catalog of declared text looks.
 *
 * A template is **not** a second renderer: it is the same `preset` / `style` / `box` / `animation`
 * an overlay already carries, bundled with a sample line. Adding one writes a normal text overlay,
 * so the painter, the panel's inspector and the agent all keep seeing one shape.
 *
 * Animation is whole-block for now (`TEXT_ANIMATIONS`): the compositor evaluates one arrival and
 * one departure per overlay. Per-character effects would need a character-level evaluator, so the
 * catalog deliberately stays within what preview and export already agree on.
 *
 * Pure data: no images, no fonts to install. The panel draws thumbnails with CSS from these same
 * fields, so a thumbnail cannot drift from what the canvas paints.
 */

import type { OverlayBox, TextAnimation, TextPreset, TextStyle } from './overlay.ts'

export interface TextTemplate {
  /** Stable id the agent names in `add_overlay.template`. */
  id: string
  /** What the panel's gallery calls it. */
  label: string
  /** The starting words; the person edits them afterwards. */
  sample: string
  box: OverlayBox
  preset?: TextPreset
  style: TextStyle
  animation?: TextAnimation
}

export const TEXT_TEMPLATES: TextTemplate[] = [
  {
    id: 'neon',
    label: '霓虹花字',
    sample: '霓虹花字',
    box: { x: 0.1, y: 0.4, w: 0.8, h: 0.2 },
    preset: 'neon',
    style: { fontSize: 84, bold: true },
    animation: { preset: 'fade', inDuration: 0.5, outDuration: 0.3 },
  },
  {
    id: 'impact',
    label: '冲击大字',
    sample: '冲击标题',
    box: { x: 0.1, y: 0.36, w: 0.8, h: 0.24 },
    style: {
      fontSize: 120,
      color: '#ffffff',
      align: 'center',
      bold: true,
      strokeColor: '#000000',
      strokeWidth: 6,
      shadowColor: 'rgba(0,0,0,0.55)',
      shadowBlur: 10,
      lineHeight: 1.1,
    },
    animation: { preset: 'scale', inDuration: 0.35, outDuration: 0.25 },
  },
  {
    id: 'badge',
    label: '标签',
    sample: 'NEW',
    box: { x: 0.06, y: 0.08, w: 0.3, h: 0.08 },
    preset: 'label',
    style: { fontSize: 40, color: '#111111', backgroundColor: '#ffe066', bold: true },
    animation: { preset: 'slide-up', inDuration: 0.3, outDuration: 0.2 },
  },
  {
    id: 'lower-third',
    label: '下三分之一',
    sample: '受访者 · 身份',
    box: { x: 0.06, y: 0.72, w: 0.5, h: 0.12 },
    style: {
      fontSize: 44,
      color: '#ffffff',
      align: 'left',
      backgroundColor: 'rgba(0,0,0,0.6)',
      lineHeight: 1.2,
    },
    animation: { preset: 'slide-left', inDuration: 0.4, outDuration: 0.25 },
  },
  {
    id: 'quote',
    label: '引用',
    sample: '“这一句值得停下来听”',
    box: { x: 0.12, y: 0.36, w: 0.76, h: 0.28 },
    style: {
      fontFamily: 'Georgia, serif',
      fontSize: 64,
      color: '#ffffff',
      align: 'center',
      italic: true,
      shadowColor: 'rgba(0,0,0,0.6)',
      shadowBlur: 8,
      lineHeight: 1.3,
    },
    animation: { preset: 'fade', inDuration: 0.6, outDuration: 0.4 },
  },
  {
    id: 'bar',
    label: '字幕条',
    sample: '一行字幕',
    box: { x: 0.08, y: 0.78, w: 0.84, h: 0.14 },
    preset: 'subtitle',
    style: { fontSize: 46, color: '#ffffff', backgroundColor: 'rgba(0,0,0,0.55)' },
    animation: { preset: 'fade', inDuration: 0.25, outDuration: 0.2 },
  },
  {
    id: 'stamp',
    label: '印章',
    sample: '重点',
    box: { x: 0.32, y: 0.4, w: 0.36, h: 0.18 },
    style: {
      fontSize: 76,
      color: '#ff3b30',
      align: 'center',
      bold: true,
      strokeColor: '#ffffff',
      strokeWidth: 3,
      lineHeight: 1.1,
    },
    animation: { preset: 'scale', inDuration: 0.3, outDuration: 0.2 },
  },
  {
    id: 'glow',
    label: '冷光描边',
    sample: '冷光标题',
    box: { x: 0.1, y: 0.4, w: 0.8, h: 0.22 },
    style: {
      fontSize: 100,
      color: '#e8f7ff',
      align: 'center',
      bold: true,
      strokeColor: '#0b2a4a',
      strokeWidth: 5,
      shadowColor: '#7df9ff',
      shadowBlur: 18,
      lineHeight: 1.15,
    },
    animation: { preset: 'slide-up', inDuration: 0.45, outDuration: 0.3 },
  },
]

export const TEXT_TEMPLATE_IDS = TEXT_TEMPLATES.map((template) => template.id)

export const textTemplateOf = (id: string): TextTemplate | undefined =>
  TEXT_TEMPLATES.find((template) => template.id === id)
