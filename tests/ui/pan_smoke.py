from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width':1280,'height':820}, color_scheme='dark')
    errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://localhost:5199/harness.html'); pg.wait_for_selector('canvas')
    pg.evaluate("window.__engine.execute('draw_ellipse', {x:2,y:2,width:12,height:12,color:9,filled:true}, 'agent')")
    pg.wait_for_timeout(200)
    z0 = pg.locator('.group .zoom').inner_text()
    # ctrl+wheel zoom in at cursor
    pg.mouse.move(640, 400)
    pg.keyboard.down('Control'); pg.mouse.wheel(0, -300); pg.keyboard.up('Control'); pg.wait_for_timeout(300)
    z1 = pg.locator('.group .zoom').inner_text(); print('zoom', z0, '->', z1); assert z1 != z0
    # space+drag pans (scrollLeft changes) and does not draw
    before = pg.evaluate("[document.querySelector('.stage').scrollLeft, document.querySelector('.stage').scrollTop]")
    px0 = pg.evaluate("Array.from(Object.values(window.__engine.project.sprites[0].cels)[0]).join('')")
    pg.keyboard.down('Space'); pg.mouse.move(640, 400); pg.mouse.down(); pg.mouse.move(740, 450, steps=5); pg.mouse.up(); pg.keyboard.up('Space')
    pg.wait_for_timeout(200)
    after = pg.evaluate("[document.querySelector('.stage').scrollLeft, document.querySelector('.stage').scrollTop]")
    print('scroll', before, '->', after); assert after != before
    assert pg.evaluate("Array.from(Object.values(window.__engine.project.sprites[0].cels)[0]).join('')") == px0, 'pan must not draw'
    # middle mouse pan
    pg.mouse.move(640, 400); pg.mouse.down(button='middle'); pg.mouse.move(600, 350, steps=3); pg.mouse.up(button='middle'); pg.wait_for_timeout(200)
    after2 = pg.evaluate("[document.querySelector('.stage').scrollLeft, document.querySelector('.stage').scrollTop]"); assert after2 != after
    # two-finger scroll (plain wheel) never moves the canvas, with any tool
    for key in ['b', 'h']:
        pg.keyboard.press(key); pg.mouse.move(640, 400)
        s0 = pg.evaluate("[document.querySelector('.stage').scrollLeft, document.querySelector('.stage').scrollTop]")
        pg.mouse.wheel(40, 40); pg.wait_for_timeout(200)
        s1 = pg.evaluate("[document.querySelector('.stage').scrollLeft, document.querySelector('.stage').scrollTop]")
        assert s0 == s1, ('wheel scrolled', key, s0, s1)
    # hand tool pans with plain left drag, and never draws
    pg.keyboard.press('h'); pg.mouse.move(640, 400); pg.mouse.down(); pg.mouse.move(700, 440, steps=3); pg.mouse.up(); pg.wait_for_timeout(200)
    after3 = pg.evaluate("[document.querySelector('.stage').scrollLeft, document.querySelector('.stage').scrollTop]"); assert after3 != after2, (after2, after3)
    assert pg.evaluate("Array.from(Object.values(window.__engine.project.sprites[0].cels)[0]).join('')") == px0, 'hand must not draw'
    pg.keyboard.press('b')
    # coords pill is fixed on the stage, shows x/y on hover
    pg.keyboard.press('0'); pg.wait_for_timeout(300)
    box = pg.locator('.canvas-frame canvas').bounding_box()
    pg.mouse.move(box['x'] + box['width']/2, box['y'] + box['height']/2); pg.wait_for_timeout(100)
    txt = pg.locator('.coords').inner_text(); assert txt.startswith('x '), txt
    pill = pg.locator('.coords').bounding_box(); assert pill['x'] > 900 and pill['y'] > 700, pill
    # pinch: many tiny ctrl+wheel events must move zoom smoothly, not jump
    pg.mouse.move(640, 400); pg.keyboard.down('Control')
    zs=[]
    for i in range(12):
        pg.mouse.wheel(0, -8); pg.wait_for_timeout(30); zs.append(pg.locator('.group .zoom').inner_text())
    pg.keyboard.up('Control'); print('pinch steps', zs)
    vals=[int(z[:-1]) for z in zs]; assert len(set(vals)) >= 10 and max(b/a for a,b in zip(vals,vals[1:])) <= 1.06, ('pinch jumps', zs)
    # zoom at cursor: the sprite pixel under the cursor stays under the cursor
    pg.keyboard.press('0'); pg.wait_for_timeout(300)
    box = pg.locator('.canvas-frame canvas').bounding_box(); z = int(pg.locator('.group .zoom').inner_text()[:-1])/100
    cx, cy = box['x'] + 3*z + z/2, box['y'] + 5*z + z/2   # centre of pixel (3,5)
    pg.mouse.move(cx, cy); pg.keyboard.down('Control')
    for i in range(10): pg.mouse.wheel(0, -20); pg.wait_for_timeout(20)
    pg.keyboard.up('Control'); pg.wait_for_timeout(300)
    box2 = pg.locator('.canvas-frame canvas').bounding_box(); z2 = int(pg.locator('.group .zoom').inner_text()[:-1])/100
    ux, uy = (cx - box2['x'])/z2, (cy - box2['y'])/z2
    print('zoom at cursor: pixel under cursor', (3.5, 5.5), '->', (round(ux,2), round(uy,2)), 'zoom', z, '->', z2)
    assert z2 > z and abs(ux-3.5) < 0.6 and abs(uy-5.5) < 0.6, 'zoom must anchor at the cursor'
    # 0 = fit
    pg.keyboard.press('0'); pg.wait_for_timeout(300); print('fit zoom', pg.locator('.group .zoom').inner_text())
    pg.screenshot(path='pas-zoom.png')
    print('errors', errs); print('PAN/ZOOM OK')
    b.close()
