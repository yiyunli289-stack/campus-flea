'use strict';

const {createHash, randomBytes} = require('node:crypto');
const https = require('node:https');
const jpeg = require('jpeg-js');
const {PNG} = require('pngjs');

const maxPhotoBytes = 10 * 1024 * 1024;
const maxPixels = 9_000_000;
const pageSize = 50;
const maxMatches = 3;
const matchFields = {
  _id:true, title:true, cat:true, condition:true, brand:true, model:true, attributes:true,
  isbn:true, edition:true, images:true, innerPhotos:true, publishPhotoSignatures:true,
  enforcement:true, moderationStatus:true
};

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalized(value) {
  return typeof value === 'string' ? value.normalize('NFKC').toLowerCase() : '';
}

function compact(value) {
  return normalized(value).replace(/[^\p{L}\p{N}]/gu, '');
}

function bigrams(characters) {
  const counts = new Map();
  for (let i = 1; i < characters.length; i++) {
    const pair = characters[i - 1] + characters[i];
    counts.set(pair, (counts.get(pair) || 0) + 1);
  }
  return counts;
}

function similarTitle(left, right) {
  const a = compact(left);
  const b = compact(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const x = [...a];
  const y = [...b];
  if (Math.min(x.length, y.length) < 4) return false;
  const leftNumbers = normalized(left).match(/\d+/g) || [];
  const rightNumbers = normalized(right).match(/\d+/g) || [];
  if (leftNumbers.length && rightNumbers.length && leftNumbers.join(',') !== rightNumbers.join(',')) return false;

  const counts = bigrams(x);
  let overlap = 0;
  for (const [pair, count] of bigrams(y)) overlap += Math.min(count, counts.get(pair) || 0);
  return (2 * overlap) / (x.length + y.length - 2) >= 0.85;
}

function isbnKey(value) {
  const key = normalized(value).replace(/[^0-9x]/g, '');
  if (!/^\d{9}[\dx]$/.test(key)) return key;
  const prefix = '978' + key.slice(0, 9);
  const sum = [...prefix].reduce((total, digit, i) => total + Number(digit) * (i % 2 ? 3 : 1), 0);
  return prefix + (10 - sum % 10) % 10;
}

function matchesAttributes(a, b) {
  if (a.cat !== b.cat || compact(a.condition || '几乎全新') !== compact(b.condition || '几乎全新')) return false;
  const pairs = [
    [compact(a.model || a.attributes?.model), compact(b.model || b.attributes?.model)],
    [compact(a.brand || a.attributes?.brand), compact(b.brand || b.attributes?.brand)]
  ];
  if (a.cat === 'book') pairs.push([isbnKey(a.isbn), isbnKey(b.isbn)], [compact(a.edition), compact(b.edition)]);
  if (a.cat === 'digital') {
    const variant = title => normalized(title).match(/(?:pro[\s-]*max|ultra|plus|mini|pro|max)\b/g)?.map(compact).join(',') || '';
    const left = variant(a.title);
    const right = variant(b.title);
    if (left !== right && (left || right)) return false;
  }
  return pairs.every(([left, right]) => !left || !right || left === right);
}

function realPhotos(listing, openid, env) {
  if (typeof env !== 'string' || !env) return [];
  const images = Array.isArray(listing.images) ? listing.images.slice(0, 9) : [];
  const innerPhotos = Array.isArray(listing.innerPhotos) ? listing.innerPhotos.slice(0, 6) : [];
  const photos = [...images, ...innerPhotos];
  return [...new Set(photos.filter(file => {
    if (typeof file !== 'string' || file.length > 500) return false;
    const match = /^cloud:\/\/([a-zA-Z0-9.-]+)\/(goods-images|goods-inner)\/([a-zA-Z0-9_-]+)\/[a-zA-Z0-9_.-]+$/.exec(file);
    return match && (match[1] === env || match[1].startsWith(env + '.')) && match[3] === openid;
  }))];
}

function decode(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return jpeg.decode(buffer, {maxResolutionInMP:9, maxMemoryUsageInMB:64, tolerantDecoding:false});
  }
  const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(pngMagic)) {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (width && height && width * height <= maxPixels) return PNG.sync.read(buffer);
  }
  return null;
}

function visualSignature({width, height, data}) {
  if (width < 9 || height < 8) return '';
  const pixels = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 9; x++) {
      const i = (Math.floor((y + 0.5) * height / 8) * width + Math.floor((x + 0.5) * width / 9)) * 4;
      pixels.push((0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) * data[i + 3] / 255);
    }
  }
  if (Math.max(...pixels) - Math.min(...pixels) < 24) return '';
  let bits = 0n;
  let changes = 0;
  for (let i = 0; i < pixels.length; i++) {
    if (i % 9 === 8) continue;
    const bit = pixels[i] > pixels[i + 1];
    bits = (bits << 1n) | BigInt(bit);
    if (bit) changes++;
  }
  return changes >= 5 && changes <= 59 ? bits.toString(16).padStart(16, '0') : '';
}

function fingerprint(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > maxPhotoBytes) return null;
  let visual = '';
  try {
    const image = decode(buffer);
    if (image) visual = visualSignature(image);
  } catch {
    // Unsupported, oversized or corrupt images still allow content comparison.
  }
  return {content:sha256(buffer), visual};
}

function similarImage(a, b) {
  if (!a || !b) return false;
  if (a.content === b.content) return true;
  if (!/^[a-f0-9]{16}$/.test(a.visual) || !/^[a-f0-9]{16}$/.test(b.visual)) return false;
  let difference = BigInt('0x' + a.visual) ^ BigInt('0x' + b.visual);
  let distance = 0;
  while (difference && distance <= 6) {
    difference &= difference - 1n;
    distance++;
  }
  return distance <= 6;
}

function downloadBounded(url) {
  if (typeof url !== 'string' || !url.startsWith('https://')) return Promise.resolve(null);
  return new Promise(resolve => {
    const request = https.get(url, response => {
      if (response.statusCode !== 200 || Number(response.headers['content-length']) > maxPhotoBytes) {
        response.destroy();
        resolve(null);
        return;
      }
      let total = 0;
      const chunks = [];
      response.on('data', chunk => {
        total += chunk.length;
        if (total <= maxPhotoBytes) chunks.push(chunk);
        else response.destroy();
      });
      response.once('end', () => resolve(total <= maxPhotoBytes ? Buffer.concat(chunks, total) : null));
      response.once('close', () => resolve(null));
      response.once('error', () => resolve(null));
    });
    const timeout = setTimeout(() => request.destroy(), 2200);
    request.once('close', () => { clearTimeout(timeout); resolve(null); });
    request.once('error', () => resolve(null));
  });
}

async function readCloudPhoto(cloud, fileID) {
  const result = await cloud.getTempFileURL({fileList:[fileID]});
  const entry = (result.fileList || []).find(item => item.fileID === fileID);
  return entry?.status === 0 ? downloadBounded(entry.tempFileURL) : null;
}

function photoEvidence(readPhoto) {
  const fingerprints = new Map();
  const deadline = Date.now() + 8500;
  let reads = 0;
  return async function signature(file, cached = []) {
    if (fingerprints.has(file)) return fingerprints.get(file);
    const previous = Array.isArray(cached) && cached.find(entry =>
      entry?.file === file && /^[a-f0-9]{64}$/.test(entry.content));
    if (previous) {
      fingerprints.set(file, previous);
      return previous;
    }
    if (reads >= 24 || Date.now() >= deadline) return null;
    reads++;
    let result = null;
    try { result = fingerprint(await readPhoto(file)); } catch {
      // Missing historical photos are excluded from the comparison.
    }
    const evidence = result && {file, ...result};
    fingerprints.set(file, evidence);
    return evidence;
  };
}

async function hasSimilarPhoto(current, previous, saved, signature) {
  if (previous.some(file => current.includes(file))) return true;
  if (!previous.length) return false;
  for (const file of previous) {
    const existing = await signature(file, saved);
    if (!existing) continue;
    for (const submitted of current) {
      if (similarImage(await signature(submitted), existing)) return true;
    }
  }
  return false;
}

async function findMatches(db, data, files, env, signature) {
  if (!files.length) return [];
  const matches = [];
  let after;
  do {
    const filter = {sellerId:data.sellerId, cat:data.cat, status:'on'};
    if (after) filter._id = db.command.gt(after);
    const {data:rows} = await db.collection('goods').where(filter)
      .field(matchFields).orderBy('_id', 'asc').limit(pageSize).get();
    for (const row of rows) {
      if (row.enforcement === 'removed' || row.moderationStatus === 'rejected' ||
          !matchesAttributes(data, row) || !similarTitle(data.title, row.title)) continue;
      const previous = realPhotos(row, data.sellerId, env);
      if (await hasSimilarPhoto(files, previous, row.publishPhotoSignatures, signature)) {
        matches.push({_id:row._id, title:row.title});
        if (matches.length === maxMatches) return matches;
      }
    }
    after = rows.length === pageSize ? rows[rows.length - 1]._id : null;
  } while (after);
  return matches;
}

function existingResult(previous, openid, requestHash) {
  if (previous.sellerId === openid && previous.publishRequestHash === requestHash) {
    return {code:0, data:{_id:previous._id}};
  }
  return {code:-1, errCode:'PUBLISH_REQUEST_CHANGED', msg:'发布内容已改变，请重新提交'};
}

function profileComplete(user) {
  return user && user.nickName && user.campus && user.contact;
}

async function publishWithReminder(db, user, listing, params, env, readPhoto) {
  let requestId = params.requestId;
  if (requestId === undefined) requestId = randomBytes(16).toString('hex');
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{12,80}$/.test(requestId)) {
    return {code:-1, msg:'发布请求无效，请重新提交'};
  }

  const {sellerId:openid} = listing;
  const requestHash = sha256(JSON.stringify(listing));
  const id = sha256(JSON.stringify([openid, requestId])).slice(0, 32);
  const goods = db.collection('goods');
  const {data:previous} = await goods.doc(id).get();
  if (previous) return existingResult(previous, openid, requestHash);

  const files = realPhotos(listing, openid, env);
  const signature = photoEvidence(readPhoto);
  const users = db.collection('users');
  for (let attempt = 0; attempt < 3; attempt++) {
    const {data:profile} = await users.doc(user._id).get();
    if (!profileComplete(profile) || profile._openid !== openid) return {code:-1, msg:'请先完善资料'};
    const revision = profile.goodsPublishRevision || 0;
    const matches = await findMatches(db, listing, files, env, signature);
    if (matches.length) {
      const confirmation = sha256(JSON.stringify([id, requestHash, matches]));
      if (params.duplicateConfirmation !== confirmation) {
        const {data:written} = await goods.doc(id).get();
        return written ? existingResult(written, openid, requestHash) : {
          code:-1, errCode:'DUPLICATE_PUBLISH', msg:'可能重复发布，请在小程序中确认后继续',
          data:{matches, confirmation}
        };
      }
    }
    const photoSignatures = [];
    for (const file of files) {
      const evidence = await signature(file);
      if (evidence) photoSignatures.push(evidence);
    }
    const result = await db.runTransaction(async tx => {
      const doc = tx.collection('goods').doc(id);
      const {data:alreadyPublished} = await doc.get();
      if (alreadyPublished) return existingResult(alreadyPublished, openid, requestHash);
      const seller = tx.collection('users').doc(user._id);
      const {data:current} = await seller.get();
      if (!profileComplete(current) || current._openid !== openid) return {code:-1, msg:'请先完善资料'};
      if ((current.goodsPublishRevision || 0) !== revision) return null;
      const now = Date.now();
      await doc.set({data:{
        ...listing, sellerName:current.nickName, sellerAvatar:current.avatarUrl || '', sellerCollege:current.college || '',
        status:'on', buyerId:'', dealPrice:null, viewCount:0, createdAt:now, updatedAt:now,
        publishRequestHash:requestHash, publishPhotoSignatures:photoSignatures
      }});
      await seller.update({data:{goodsPublishRevision:revision + 1}});
      return {code:0, data:{_id:id}};
    });
    if (result) return result;
  }
  return {code:-1, errCode:'PUBLISH_BUSY', msg:'发布请求较多，请稍后重试'};
}

function publicListing(listing) {
  const {publishRequestHash, publishPhotoSignatures, ...view} = listing;
  return view;
}

module.exports = {publishWithReminder, readCloudPhoto, publicListing, similarTitle, matchesAttributes, fingerprint, similarImage};
