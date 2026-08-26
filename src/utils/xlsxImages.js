// 把 Markdown 正文里的 base64 图片注入到 xlsx 中（不依赖付费的 SheetJS Pro）
// 原理：xlsx 本质是 zip，用 fflate 解压 -> 加 xl/media + drawing + 各种关系 -> 重新压缩
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate'

const EMU = 9525 // 1px = 9525 EMU (96 DPI)

// 从 data:image base64 解出字节与扩展名
export function dataURIToBytes(dataURI) {
  const m = /^data:image\/([a-zA-Z0-9.+-]+);base64,(.*)$/.exec(dataURI)
  if (!m) return null
  let ext = m[1].toLowerCase()
  if (ext === 'jpeg') ext = 'jpg'
  if (ext === 'svg+xml') ext = 'svg'
  const b64 = m[2]
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary')
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return { bytes, ext }
}

// 抽出正文里所有 data:image 的 dataURI
export function extractImageDataURIs(content) {
  const re = /!\[[^\]]*\]\((data:image\/[^)\s]+)\)/g
  const out = []
  let mm
  while ((mm = re.exec(content || ''))) out.push(mm[1])
  return out
}

function buildAnchor(col, row, xOff, yOff, wEMU, hEMU, id) {
  return `<xdr:twoCellAnchor>
  <xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>${xOff}</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>${yOff}</xdr:rowOff></xdr:from>
  <xdr:to><xdr:col>${col}</xdr:col><xdr:colOff>${xOff + wEMU}</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>${yOff + hEMU}</xdr:rowOff></xdr:to>
  <xdr:pic>
    <xdr:nvPicPr><xdr:cNvPr id="${id}" name="Picture ${id}"/><xdr:cNvPicPr/></xdr:nvPicPr>
    <xdr:blipFill><a:blip r:embed="rId${id}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
    <xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
  </xdr:pic>
  <xdr:clientData/>
</xdr:twoCellAnchor>`
}

function buildDrawing(anchors) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${anchors.join('\n')}
</xdr:wsDr>`
}

function buildDrawingRels(media) {
  const rels = media
    .map((m, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${m.name}"/>`)
    .join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`
}

function nextRelId(relsXml) {
  const ids = [...relsXml.matchAll(/Id="(rId\d+)"/g)].map((m) => parseInt(m[1].slice(3), 10))
  const max = ids.length ? Math.max(...ids) : 0
  return `rId${max + 1}`
}

function addRelationship(relsXml, id, type, target) {
  const rel = `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`
  if (relsXml.includes('</Relationships>')) return relsXml.replace('</Relationships>', rel + '</Relationships>')
  return relsXml + rel
}

function addDrawingRef(sheetXml, rid) {
  let out = sheetXml
  if (!out.includes('xmlns:r=')) {
    out = out.replace(/<worksheet\b/, '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"')
  }
  const drawingEl = `<drawing r:id="${rid}"/>`
  if (out.includes('</sheetData>')) return out.replace('</sheetData>', `</sheetData>${drawingEl}`)
  return out.replace('</worksheet>', `${drawingEl}</worksheet>`)
}

function addContentTypes(ctXml, media) {
  let out = ctXml
  const exts = [...new Set(media.map((m) => m.ext))]
  for (const ext of exts) {
    const ct = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
    if (!out.includes(`Extension="${ext}"`)) {
      out = out.replace('</Types>', `<Default Extension="${ext}" ContentType="${ct}"/>` + '</Types>')
    }
  }
  if (!out.includes('/xl/drawings/drawing1.xml')) {
    const ov = `<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`
    out = out.replace('</Types>', ov + '</Types>')
  }
  return out
}

// xlsxBytes: Uint8Array/ArrayBuffer；placements: [{ sheetRow: 0基(表头为0), images: [{bytes, ext, w, h}] }]
// 返回带图片的 xlsx 字节；若无图片原样返回
export function embedImages(xlsxBytes, placements) {
  const u8 = xlsxBytes instanceof Uint8Array ? xlsxBytes : new Uint8Array(xlsxBytes)
  const files = unzipSync(u8)
  const media = []
  const anchors = []
  let id = 0
  const targetW = 300 // 图片最大显示宽度(px)
  for (const p of placements) {
    p.images.forEach((img, i) => {
      id++
      const mediaName = `image${id}.${img.ext}`
      media.push({ name: mediaName, bytes: img.bytes, ext: img.ext })
      const scale = Math.min(1, targetW / (img.w || targetW))
      const wEMU = Math.round((img.w || targetW) * scale * EMU)
      const hEMU = Math.round((img.h || targetW) * scale * EMU)
      const col = 6 // G 列（内容列），图片显示在正文右侧
      const xOff = 5 * EMU
      const yOff = i * (hEMU + 10 * EMU) // 同笔记多张图向下堆叠
      anchors.push(buildAnchor(col, p.sheetRow, xOff, yOff, wEMU, hEMU, id))
    })
  }
  if (!media.length) return xlsxBytes

  for (const m of media) files[`xl/media/${m.name}`] = m.bytes
  files['xl/drawings/drawing1.xml'] = strToU8(buildDrawing(anchors))
  files['xl/drawings/_rels/drawing1.xml.rels'] = strToU8(buildDrawingRels(media))

  const sheetRelsPath = 'xl/worksheets/_rels/sheet1.xml.rels'
  const sheetPath = 'xl/worksheets/sheet1.xml'
  if (!files[sheetPath] || !files['[Content_Types].xml']) {
    return xlsxBytes // 结构不符，原样返回，避免破坏文件
  }
  // SheetJS 在没有外部关系时不会生成 sheet 的 rels 文件，需要新建
  if (!files[sheetRelsPath]) {
    files[sheetRelsPath] = strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
    )
  }
  const drawRid = nextRelId(strFromU8(files[sheetRelsPath]))
  files[sheetRelsPath] = strToU8(
    addRelationship(
      strFromU8(files[sheetRelsPath]),
      drawRid,
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing',
      '../drawings/drawing1.xml'
    )
  )
  files[sheetPath] = strToU8(addDrawingRef(strFromU8(files[sheetPath]), drawRid))
  files['[Content_Types].xml'] = strToU8(addContentTypes(strFromU8(files['[Content_Types].xml']), media))

  return zipSync(files, { level: 6 })
}
