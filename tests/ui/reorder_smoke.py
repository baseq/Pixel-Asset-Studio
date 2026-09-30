from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width':1280,'height':820}, color_scheme='dark')
    errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://localhost:5199/harness.html'); pg.wait_for_selector('canvas')
    pg.evaluate("""() => { const e = window.__engine;
      e.execute('draw_from_ascii', {rows:['1']}, 'agent'); e.execute('frame_add', {}, 'agent'); e.execute('draw_from_ascii', {frame:1, rows:['2']}, 'agent');
      e.execute('frame_add', {}, 'agent'); e.execute('draw_from_ascii', {frame:2, rows:['3']}, 'agent');
      e.execute('layer_add', {name:'B'}, 'agent'); e.execute('layer_add', {name:'C'}, 'agent'); }""")
    pg.wait_for_timeout(300)
    first = lambda: pg.evaluate("(function(){const s=window.__engine.project.sprites[0]; return s.frames.map(f => s.cels[s.layers[0].id+':'+f.id][0])})()")
    assert first()==[1,2,3]
    # drag frame 0 to after frame 2 (drop slot 3)
    f0 = pg.get_by_role('button', name='Frame 0').bounding_box(); f2 = pg.get_by_role('button', name='Frame 2').bounding_box()
    pg.mouse.move(f0['x']+28, f0['y']+28); pg.mouse.down(); pg.mouse.move(f0['x']+40, f0['y']+30, steps=2)
    pg.mouse.move(f2['x']+f2['width']-4, f2['y']+28, steps=6); pg.wait_for_timeout(100)
    assert pg.locator('.frame-ghost').count()==1 and pg.locator('.frame-ghost canvas').count()==1, 'ghost with content while dragging'
    assert pg.locator('.frame.drop-after').count()==1
    pg.mouse.up(); pg.wait_for_timeout(300)
    assert first()==[2,3,1], first()
    assert 'frame 2' in pg.locator('.stat small', has_text='frame').inner_text()
    # a plain click still selects (no accidental drag)
    pg.get_by_role('button', name='Frame 0').click(); pg.wait_for_timeout(100)
    assert 'frame 0' in pg.locator('.stat small', has_text='frame').inner_text()
    # layers: display top-down [C, B, Layer 1]; drag C (row 0) below Layer 1 (slot 3) -> layer order bottom-up [C, Layer 1, B]
    names = lambda: pg.evaluate("window.__engine.project.sprites[0].layers.map(l=>l.name)")
    rows = pg.locator('li.layer-row'); r0 = rows.nth(0).bounding_box(); r2 = rows.nth(2).bounding_box()
    pg.mouse.move(r0['x']+120, r0['y']+r0['height']/2); pg.mouse.down(); pg.mouse.move(r0['x']+120, r0['y']+r0['height']/2+8, steps=2)
    pg.mouse.move(r2['x']+120, r2['y']+r2['height']-2, steps=6); pg.wait_for_timeout(100)
    assert pg.locator('.layer-ghost').count()==1 and 'C' in pg.locator('.layer-ghost').inner_text()
    pg.mouse.up(); pg.wait_for_timeout(300)
    assert names()==['C','Layer 1','B'], names()
    assert pg.evaluate("window.__engine.project.sprites[0].layers.findIndex(l => l.name==='C')")==0
    pg.screenshot(path='pas-reorder.png')
    print('errors', errs, 'REORDER OK')
    b.close()
