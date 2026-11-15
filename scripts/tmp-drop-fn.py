p = r'apps/electron/src/renderer/components/canvas/CanvasPage.tsx'
src = open(p, encoding='utf-8').read()

TARGETS = [
    'const describeNode = React.useCallback(',
    'const addEmptyMediaNode = React.useCallback(',
    'const generateFor = React.useCallback(',
    'const addNodeInput = React.useCallback(',
]


def remove_callback(text, signature):
    idx = text.find(signature)
    assert idx != -1, signature
    # Swallow the comment block immediately above, if there is one.
    start = idx
    head = text.rfind('/**', 0, idx)
    if head != -1 and text[head:idx].count('*/') == 1 and text[head:idx].strip().endswith('*/'):
        start = head
    # Walk the argument list of React.useCallback( ... ) to its matching paren.
    open_paren = text.find('(', idx + len(signature) - 1)
    depth = 0
    i = open_paren
    in_str = None
    while i < len(text):
        ch = text[i]
        if in_str:
            if ch == '\\':
                i += 2
                continue
            if ch == in_str:
                in_str = None
        elif ch in '"\'`':
            in_str = ch
        elif ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
            if depth == 0:
                end = i + 1
                break
        i += 1
    # Take the trailing comma-less line end.
    while end < len(text) and text[end] in ' \t':
        end += 1
    if end < len(text) and text[end] == '\n':
        end += 1
    print('removing', signature.strip(), 'chars', start, end)
    return text[:start] + text[end:]


for signature in TARGETS:
    src = remove_callback(src, signature)

# The media-channel mount effect: ask once per mount, then keep it out of the canvas.
marker = '  // Which accounts can draw.'
i = src.find(marker)
assert i != -1, 'channel effect comment'
j = src.find('  }, [])', i)
assert j != -1, 'channel effect end'
j += len('  }, [])')
while j < len(src) and src[j] == '\n':
    j += 1
src = src[:i] + src[j:]
print('removed channel effect')

open(p, 'w', encoding='utf-8').write(src)
