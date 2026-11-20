const app=getApp();
require('../../utils/page')({
  data:{tab:'notifications',list:[],loading:false,error:''},
  onShow(){this.load();},
  onTab(e){this.setData({tab:e.currentTarget.dataset.tab});this.load();},
  async load(){
    this.setData({loading:true,error:''});
    try{await app.login();const list=await app.call('governance',{action:this.data.tab});this.setData({list:list.map(x=>({...x,timeText:new Date(x.createdAt).toLocaleString(),stateText:x.state==='resolved'?'已处理':'待处理'}))});}
    catch(e){this.setData({error:e.message,list:[]});}
    finally{this.setData({loading:false});}
  },
  async onRead(e){try{await app.call('governance',{action:'readNotification',id:e.currentTarget.dataset.id});this.load();}catch(err){wx.showToast({title:err.message,icon:'none'});}},
  onUnblock(e){const targetId=e.currentTarget.dataset.id;wx.showModal({title:'解除拉黑？',content:'解除后可以重新报价或发送消息。',success:async r=>{if(!r.confirm)return;try{await app.call('governance',{action:'unblock',targetId});this.load();}catch(err){wx.showToast({title:err.message,icon:'none'});}}});}
});
