function withPageReload(page) {
  function stopReload() {
    this._reloadTicket = null;
    this._reloadVisible = false;
  }

  return {
    ...page,
    onShow() {
      this._reloadVisible = true;
      return this.reload();
    },
    onHide: stopReload,
    onUnload: stopReload
  };
}

async function reloadLatest(page, request, apply, showError) {
  if (!page._reloadVisible) return;

  const ticket = {};
  page._reloadTicket = ticket;
  const isCurrent = () => page._reloadTicket === ticket;

  try {
    const result = await request(isCurrent);
    if (isCurrent()) apply(result);
  } catch (err) {
    if (isCurrent()) showError(err);
  }
}

module.exports = { withPageReload, reloadLatest };
