from playwright.sync_api import sync_playwright
import base64, zlib, struct
def png(w,h,px):
    raw=b''.join(b'\x00'+bytes(px[y]) for y in range(h))
    def chunk(t,d): return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')
rows=[]
for y in range(16):
    r=[]
    for x in range(16): r += ([250,120,30,255] if x<8 else [30,200,250,255])
    rows.append(r)
b64=base64.b64encode(png(16,16,rows)).decode()
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width':1280,'height':820}, color_scheme='dark')
    errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://localhost:5199/harness.html'); pg.wait_for_selector('canvas')
    pg.evaluate("window.__engine.execute('draw_rect', {x:0,y:0,width:16,height:16,color:9,filled:true}, 'agent')")
    pg.evaluate("""(b64) => { window.__pickImage = async () => { const bin = atob(b64); const bytes = new Uint8Array(bin.length); for (let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
        const bmp = await createImageBitmap(new Blob([bytes], {type:'image/png'})); const c = document.createElement('canvas'); c.width=bmp.width; c.height=bmp.height; const ctx=c.getContext('2d'); ctx.drawImage(bmp,0,0);
        return {path:'/tmp/photo.png', width:c.width, height:c.height, data:ctx.getImageData(0,0,c.width,c.height).data}; } }""", b64)
    pg.get_by_role('button', name='Import…').click(); pg.wait_for_selector('.modal')
    assert pg.locator('.import-form select').nth(0).input_value()=='frame'
    pg.locator('.import-form select').nth(3).select_option('auto'); pg.wait_for_timeout(300)
    pg.get_by_role('button', name='Import', exact=True).click(); pg.wait_for_timeout(600)
    st = pg.evaluate("(function(){const e=window.__engine; const s=e.project.sprites[0]; const pal=e.project.palettes[s.palette]; return {frames:s.frames.length, palette:s.palette, n:pal.colors.length, groups:pal.groups, f0:Array.from(Object.values(s.cels)[0]).slice(0,4)}})()")
    print(st)
    assert st['frames']==2 and st['palette']=='db16' and st['n']>17 and st['groups'][0]['name']=='photo' and st['f0']==[9,9,9,9]
    assert pg.locator('.pal-group-name').count()==1
    assert 'frame 1' in pg.locator('.stat small', has_text='frame').inner_text()
    pg.screenshot(path='pas-import-extend.png')
    print('errors', errs, 'IMPORT EXTEND OK')
    b.close()
