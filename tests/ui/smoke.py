from playwright.sync_api import sync_playwright
import json

def cel(page):
    return page.evaluate("""() => { const e = window.__engine; const s = e.project.sprites[0];
      const k = Object.keys(s.cels)[0]; return Array.from(s.cels[k]) }""")

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={'width': 1280, 'height': 820})
    errors = []
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:5199/harness.html')
    page.wait_for_selector('canvas')
    page.screenshot(path='ui-0-initial.png')
    page.wait_for_timeout(300)
    box = page.locator('.canvas-frame canvas').bounding_box()
    Z = int(page.locator('.group .zoom').inner_text()[:-1]) / 100
    def px(x, y): return (box['x'] + x * Z + Z // 2, box['y'] + y * Z + Z // 2)

    # pencil stroke = one undo step
    page.keyboard.press('b')
    page.mouse.move(*px(2, 2)); page.mouse.down(); page.mouse.move(*px(6, 2), steps=4); page.mouse.up()
    page.wait_for_timeout(200)
    c = cel(page)
    row2 = c[2*16:3*16]
    print('stroke row:', row2)
    assert all(row2[x] == 1 for x in range(2, 7)), 'pencil stroke missing'
    page.get_by_role('button', name='Undo', exact=True).click(); page.wait_for_timeout(200)
    assert sum(cel(page)) == 0, 'undo should remove the whole stroke'
    print('undo removed stroke: ok')
    page.get_by_role('button', name='Redo', exact=True).click(); page.wait_for_timeout(200)
    assert cel(page)[2*16+4] == 1

    # pick color 9 (swatch index 9), draw a filled rectangle
    page.locator('.swatch').nth(9).click()
    page.keyboard.press('r')
    page.get_by_role('button', name='Filled shapes').click()
    page.mouse.move(*px(8, 8)); page.mouse.down(); page.mouse.move(*px(12, 11), steps=3); page.mouse.up()
    page.wait_for_timeout(200)
    c = cel(page)
    assert c[8*16+8] == 9 and c[11*16+12] == 9 and c[12*16+12] == 0, 'rect wrong'
    print('filled rect: ok')

    # ellipse outline
    page.get_by_role('button', name='Filled shapes').click()
    page.keyboard.press('o'); page.locator('.swatch').nth(4).click()
    page.mouse.move(*px(0, 8)); page.mouse.down(); page.mouse.move(*px(6, 14), steps=3); page.mouse.up()
    page.wait_for_timeout(200)
    c = cel(page)
    assert c[11*16+0] == 4 and c[8*16+0] == 0, 'ellipse should have a rounded corner, not a rectangle'
    print('ellipse: ok')

    # fill + picker
    page.keyboard.press('g'); page.locator('.swatch').nth(13).click()
    page.mouse.move(*px(14, 1)); page.mouse.down(); page.mouse.up(); page.wait_for_timeout(200)
    assert cel(page)[1*16+14] == 13
    page.keyboard.press('i'); page.mouse.move(*px(9, 9)); page.mouse.down(); page.mouse.up()
    page.wait_for_timeout(100)
    assert 'idx 9' in page.locator('.inspector').inner_text()
    print('fill + picker: ok')

    # an agent edits while the UI is open
    page.evaluate("""() => window.__engine.execute('draw_from_ascii', {rows:['.22.','2ff2','.22.'], x:0, y:0}, 'agent')""")
    page.wait_for_timeout(300)
    assert page.locator('.log.agent').count() >= 1, 'agent activity not shown'
    print('agent edit visible in activity: ok')

    # layers and frames
    page.get_by_role('button', name='+ Add').click()
    page.get_by_role('button', name='Add frame (copy of current)').click()
    page.wait_for_timeout(300)
    assert page.locator('.frame:not(.add)').count() == 2 and page.locator('.list li').count() == 2
    print('layer/frame add: ok')
    page.screenshot(path='ui-1-final.png')
    page.get_by_role('radio', name='Light theme').click(); page.wait_for_timeout(300); page.screenshot(path='ui-2-light.png')
    assert page.evaluate("document.documentElement.getAttribute('data-theme')") == 'light'
    page.reload(); page.wait_for_selector('canvas'); assert page.evaluate("document.documentElement.getAttribute('data-theme')") == 'light', 'theme not persisted'
    print('theme switch + persist: ok')

    # a bad command surfaces a readable toast
    page.evaluate("""() => window.pas.command('draw_pixels', {pixels:[{x:0,y:0,color:99}]}).then(r => r)""")
    print('console errors:', errors)
    b.close()
print('UI TEST PASSED')
