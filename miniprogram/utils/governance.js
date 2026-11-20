function report(targetType,targetId) {
  const app=getApp();
  app.login().then(()=>wx.showActionSheet({itemList:['虚假信息','违禁或盗版','涉嫌诈骗','骚扰','其他'],success:r=>{
    const reason=['虚假信息','违禁或盗版','涉嫌诈骗','骚扰','其他'][r.tapIndex];
    wx.showModal({title:'举报 · '+reason,editable:true,placeholderText:'补充说明（选填）',success:async m=>{if(!m.confirm)return;try{await app.call('report',{action:'create',targetType,targetId,reason,detail:m.content||''});wx.showToast({title:'举报已提交'});}catch(e){wx.showToast({title:e.message,icon:'none'});}}});
  }})).catch(e=>wx.showToast({title:e.message,icon:'none'}));
}
function block(targetId) {
  wx.showModal({title:'确认拉黑？',content:'拉黑后双方不能新报价或发送消息，可在安全中心解除。',success:async r=>{if(!r.confirm)return;try{await getApp().call('governance',{action:'block',targetId});wx.showToast({title:'已拉黑'});}catch(e){wx.showToast({title:e.message,icon:'none'});}}});
}
module.exports={report,block};
