from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width':1280,'height':820}, color_scheme='dark')
    errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://localhost:5199/harness.html'); pg.wait_for_selector('canvas')
    # 14 frames -> strip must scroll, bar must stay within window
    pg.evaluate("() => { for (let i=0;i<13;i++) window.__engine.execute('frame_add', {copyFrom:0}, 'agent') }")
    pg.get_by_role('button', name='Frame 13').click(); pg.wait_for_timeout(300)
    tl = pg.locator('.timeline').bounding_box(); assert tl['x'] >= 0 and tl['x']+tl['width'] <= 1280, tl
    assert pg.evaluate("(function(){const f=document.querySelector('.frames'); return f.scrollWidth > f.clientWidth})()"), 'frames should scroll'
    assert pg.evaluate("(function(){const f=document.querySelector('.frames'); const a=f.querySelector('[data-active]').getBoundingClientRect(); const r=f.getBoundingClientRect(); return a.left>=r.left-1 && a.right<=r.right+1})()"), 'active frame should be scrolled into view'
    # drag the inspector by its grip to the left; position persists across reload
    grip = pg.locator('.inspector .grip').bounding_box()
    pg.mouse.move(grip['x']+7, grip['y']+9); pg.mouse.down(); pg.mouse.move(400, 300, steps=8); pg.mouse.up(); pg.wait_for_timeout(200)
    box = pg.locator('.inspector').bounding_box(); assert box['x'] < 500, box
    pg.reload(); pg.wait_for_selector('canvas'); box2 = pg.locator('.inspector').bounding_box(); assert abs(box2['x']-box['x']) < 2, (box, box2)
    # double-click grip resets
    grip = pg.locator('.inspector .grip').bounding_box(); pg.mouse.dblclick(grip['x']+7, grip['y']+9); pg.wait_for_timeout(200)
    box3 = pg.locator('.inspector').bounding_box(); assert box3['x'] > 900, box3
    # every panel has a grip
    assert pg.locator('.grip').count() == 5, pg.locator('.grip').count()
    pg.screenshot(path='pas-frames-scroll.png')
    print('errors', errs); print('MOVE OK')
    b.close()
