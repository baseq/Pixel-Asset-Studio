from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width':1280,'height':820}, color_scheme='dark')
    errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://localhost:5199/harness.html'); pg.wait_for_selector('canvas')
    pg.evaluate("""() => { const e = window.__engine;
      e.execute('draw_ellipse', {x:2,y:4,width:12,height:10,color:9,filled:true}, 'agent');
      e.execute('frame_add', {copyFrom:0}, 'agent'); e.execute('clear', {frame:1}, 'agent');
      e.execute('draw_ellipse', {frame:1, x:1,y:6,width:14,height:8,color:9,filled:true}, 'agent');
      e.execute('frame_add', {copyFrom:0}, 'agent'); }""")
    pg.wait_for_timeout(300)
    # onion skin on, select frame 1
    pg.get_by_role('button', name='Onion skin: previous frame in red, next in blue').click()
    pg.get_by_role('button', name='Frame 1').click(); pg.wait_for_timeout(300)
    pg.screenshot(path='pas-onion.png')
    # tag editor
    pg.get_by_title('Edit tags').click(); pg.wait_for_selector('.tag-editor')
    pg.locator('.tag-form input').nth(0).fill('idle'); pg.locator('.tag-form input').nth(1).fill('0'); pg.locator('.tag-form input').nth(2).fill('2')
    pg.get_by_role('button', name='Save tag').click(); pg.wait_for_timeout(300)
    assert pg.evaluate("window.__engine.project.sprites[0].tags.length") == 1
    assert 'idle · 0–2' in pg.locator('.timeline').inner_text()
    # move + delete
    pg.evaluate("window.__engine.execute('frame_move', {from:2, to:1}, 'human')"); pg.get_by_role('button', name='Frame 1').click(); pg.wait_for_timeout(200)
    pg.get_by_role('button', name='Delete frame').click(); pg.wait_for_timeout(200)
    assert pg.evaluate("window.__engine.project.sprites[0].frames.length") == 2
    # play + speed
    pg.locator('.timeline .speed').select_option('2')
    pg.get_by_role('button', name='Frame 0').click()
    pg.get_by_role('button', name='Play').click(); pg.wait_for_timeout(60)
    seen=set()
    for i in range(12): seen.add(pg.locator('.coords').inner_text()); seen.add(pg.locator('.stat small', has_text='frame').inner_text()); pg.wait_for_timeout(40)
    assert any('frame 1' in x for x in seen) and any('frame 0' in x for x in seen), ('canvas frame should change while playing', seen)
    assert pg.get_by_role('button', name='Pause').count() == 1
    pg.get_by_role('button', name='Pause').click()
    # export menu
    pg.get_by_role('button', name='Export ▾').click(); pg.get_by_role('menuitem', name='Animated GIF 4×').click(); pg.wait_for_timeout(200)
    ex = pg.evaluate("window.__exports")
    assert ex and ex[-1]['kind']=='gif' and ex[-1]['scale']==4, ex
    pg.get_by_role('button', name='Export ▾').click(); pg.wait_for_timeout(200)
    pg.screenshot(path='pas-export-menu.png')
    print('errors:', errs); print('ANIM UI OK')
    b.close()
