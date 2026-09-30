from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width':1280,'height':820}, color_scheme='dark')
    errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://localhost:5199/harness.html'); pg.wait_for_selector('canvas')
    pg.evaluate("window.__engine.execute('draw_from_ascii', {rows:['12','34']}, 'agent')"); pg.wait_for_timeout(200)
    pg.wait_for_timeout(300); box = pg.locator('.canvas-frame canvas').bounding_box(); Z = int(pg.locator('.group .zoom').inner_text()[:-1]) / 100
    def px(x, y): return (box['x'] + x*Z + Z/2, box['y'] + y*Z + Z/2)
    def rows(): return pg.evaluate("(function(){const s=window.__engine.project.sprites[0]; const d=Object.values(s.cels)[0]; return Array.from({length:s.height},(_,y)=>Array.from(d.slice(y*s.width,(y+1)*s.width)).join(''))})()")
    pg.keyboard.press('m')
    # marquee over the 2x2 block
    pg.mouse.move(*px(0,0)); pg.mouse.down(); pg.mouse.move(*px(1,1), steps=3); pg.mouse.up(); pg.wait_for_timeout(100)
    # drag it 4 right, 3 down
    pg.mouse.move(*px(0,0)); pg.mouse.down(); pg.mouse.move(*px(4,3), steps=4); pg.mouse.up(); pg.wait_for_timeout(300)
    r = rows(); print(r[3][:8], r[4][:8])
    assert r[0][:2]=='00' and r[3][4:6]=='12' and r[4][4:6]=='34', r
    # delete clears the moved selection
    pg.keyboard.press('Delete'); pg.wait_for_timeout(200)
    r = rows(); assert r[3][4:6]=='00', r
    pg.get_by_role('button', name='Undo', exact=True).click(); pg.wait_for_timeout(200)
    assert rows()[3][4:6]=='12'
    # layers: add, rename, opacity, move, delete
    pg.get_by_role('button', name='+ Add').click(); pg.wait_for_timeout(200)
    names = lambda: pg.evaluate("window.__engine.project.sprites[0].layers.map(l=>l.name+':'+l.opacity)")
    pg.locator('li.layer-row', has_text='Layer 2').locator('.layer-name').dblclick(); pg.get_by_label('Layer name: Layer 2').fill('Outline'); pg.get_by_label('Layer name: Layer 2').press('Enter'); pg.wait_for_timeout(200)
    assert names()[1].startswith('Outline'), names()
    pg.get_by_label('Opacity of Outline').fill('40'); pg.wait_for_timeout(200)
    assert names()[1]=='Outline:0.4', names()
    pg.get_by_role('button', name='Delete layer').click(); pg.wait_for_timeout(200)
    assert len(names())==1, names()
    pg.screenshot(path='pas-select.png')
    print('errors', errs); print('SELECT+LAYERS OK')
    b.close()
