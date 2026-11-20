'use strict';
const { id } = require('./core');

const capabilities = ['publish', 'offer', 'message', 'upload', 'profile'];
const hour = 3600000;
const blockedAccount = u => !u || ['banned', 'deleted'].includes(u.accountStatus);
const epoch = u => u?.accessEpoch || '';
const generation = g => g?.tradeVersion || '';
const time = x => {
  if (typeof x === 'number') return x;
  const value = new Date(x?.$date ?? x).getTime();
  return Number.isFinite(value) ? value : 0;
};

function accountState(u, now) {
  const active = u.accountStatus === 'restricted' && (!u.restrictedUntil || u.restrictedUntil > now);
  const status = u.accountStatus === 'restricted' && !active ? 'normal' : u.accountStatus || 'normal';
  const restrictions = active ? (u.restrictions || []).filter(x => capabilities.includes(x)) : [];
  return {
    accountStatus: status,
    restrictions,
    restrictedUntil: active ? u.restrictedUntil || 0 : 0,
    allowedCapabilities: blockedAccount(u) ? [] : capabilities.filter(x => !restrictions.includes(x)),
    governanceReason: status === 'normal' ? '' : u.governanceReason || '',
    governanceActionId: status === 'normal' ? '' : u.governanceActionId || ''
  };
}

async function parties(s, g, buyerId, tx = s.store) {
  const seller = await s.findUser(g?.sellerId, tx);
  const buyer = await s.findUser(buyerId, tx);
  return { seller, buyer };
}

function listingState(g, seller, buyer) {
  if (!g || g.status === 'deleted') return 'deleted';
  if (g.enforcement === 'removed' || g.moderationStatus === 'rejected') return 'removed';
  if (['on', 'locked'].includes(g.status) &&
      (blockedAccount(seller) || (g.sellerEpoch || '') !== epoch(seller))) return 'off';
  if (g.status === 'locked' && g.buyerId &&
      (blockedAccount(buyer) || (g.buyerEpoch || '') !== epoch(buyer))) return 'off';
  return g.status;
}

function livePair(g, c, seller, buyer, now, capability) {
  const state = listingState(g, seller, g?.buyerId === c?.buyerId ? buyer : null);
  return !!c && !!seller && !!buyer && generation(g) === generation(c) &&
    (c.sellerEpoch || '') === epoch(seller) && (c.buyerEpoch || '') === epoch(buyer) &&
    accountState(seller, now).allowedCapabilities.includes(capability) &&
    accountState(buyer, now).allowedCapabilities.includes(capability) &&
    (state === 'on' || (state === 'locked' && g.buyerId === c.buyerId));
}

function offerState(o, g, seller, buyer, now) {
  if (!['pending', 'accepted'].includes(o.status)) return o.status;
  if (blockedAccount(seller) || blockedAccount(buyer) || generation(o) !== generation(g) ||
      (o.sellerEpoch || '') !== epoch(seller) || (o.buyerEpoch || '') !== epoch(buyer)) return 'closed';
  const state = listingState(g, seller, g?.buyerId === o.buyerId ? buyer : null);
  if (o.status === 'accepted') return state === 'locked' && g.buyerId === o.buyerId &&
    (!g.acceptedOfferId || g.acceptedOfferId === o._id) ? 'accepted' : 'closed';
  if (state === 'locked') return 'rejected';
  if (state !== 'on') return 'closed';
  return offerExpiry(o, g) <= now ? 'expired' : 'pending';
}

function offerExpiry(o, g) {
  return o.expiresAt || time(o.createdAt) + (g?.offerDurationHours || 48) * hour;
}

async function closeTrade(s, tx, g, status, reason, fields = {}) {
  const token = id();
  const next = {
    ...g, status, buyerId: '', buyerEpoch: '', acceptedOfferId: '', dealPrice: null,
    lockedAt: 0, meetupConfirmedAt: 0, tradeVersion: token, updatedAt: s.now(), ...fields
  };
  await tx.put('goods', g._id, next);
  await s.enqueue(tx, 'goods-state', token, {
    goodsId: g._id, tradeVersion: generation(g), state: reason, selectedId: g.acceptedOfferId || ''
  });
  return next;
}

function listingSummary(g, state, isOwner = false) {
  return {
    _id: g._id, status: state, enforcement: state === 'removed' ? 'removed' : g.enforcement || 'normal',
    title: state === 'removed' ? '商品已违规下架' : g.title, images: [], innerPhotos: [],
    unavailable: state === 'removed',
    ...(isOwner ? { sellerId: g.sellerId, governanceReason: g.governanceReason || '' } : {})
  };
}

module.exports = {
  capabilities, hour, blockedAccount, epoch, generation, time, accountState, parties,
  listingState, livePair, offerState, offerExpiry, closeTrade, listingSummary
};
