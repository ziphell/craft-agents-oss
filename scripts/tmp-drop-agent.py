p = r'apps/electron/src/renderer/components/canvas/CanvasPage.tsx'
text = open(p, encoding='utf-8').read()


def cut_block(start_needle, end_needle, label):
    start = text.index(start_needle)
    end = text.index(end_needle, start) + len(end_needle)
    print(label, start, end)
    return text[:start] + text[end:]


# 1. the agent state
text = cut_block("  const [agentOpen, setAgentOpen] = React.useState(false)", "  const [asking, setAsking] = React.useState(false)\n", 'state: ')

# 2. everything from the session comment through askTheCanvas
text = cut_block(
    "  /**\n   * The canvas has its own conversation: one per board, remembered on this machine.",
    "  }, [ask, asking, ensureAgentSession, onSendMessage, t])\n",
    'session + composer logic: ',
)

# 3. the toolbar button (the whole <Button ...> block for the agent)
start = text.index("          <Button\n            variant={agentOpen ? 'secondary' : 'ghost'}")
end = text.index("</Button>", start) + len("</Button>\n")
print('toolbar button:', start, end)
text = text[:start] + text[end:]

# 4. the composer + the right panel
start = text.index("          {/* The agent lives on the canvas, not in another tab.")
end_marker = "          ) : null}\n        </div>\n"
end = text.index(end_marker, start) + len(end_marker)
print('composer + panel:', start, end)
text = text[:start] + "        </div>\n" + text[end:]

# 5. the minimap no longer has to dodge a panel
text = text.replace("{minimap && !(agentOpen && agentSessionId) ? (", "{minimap ? (")

open(p, 'w', encoding='utf-8').write(text)
print('done')
