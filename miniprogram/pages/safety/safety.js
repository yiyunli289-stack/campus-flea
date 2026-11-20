const app=getApp();
require('../../utils/page')({
  data:{tab:'notifications',list:[],loading:false,error:''},
  onShow(){this.load();},
  onTab(e){this.setData({tab:e.currentTarget.dataset.tab});this.load();},
  async load(){
    this.setData({loading:true,error:''});
    try{const user=await app.login();this.setData({user,until:user.restrictedUntil ? new Date(user.restrictedUntil).toLocaleString() : '',
      reason:user.governanceReason || '',restrictions:(user.restrictions || []).map(x=>({publish:'商品管理',offer:'报价',message:'私聊',upload:'上传',profile:'资料编辑'})[x]).join('、')});
      if (user.accountStatus === 'deleted') { this.setData({list:[]}); return; }
      const list=await app.call('governance',{action:this.data.tab});this.setData({list:list.map(x=>({...x,timeText:new Date(x.createdAt).toLocaleString(),stateText:x.state==='resolved'?'已处理':'待处理'}))});}
    catch(e){this.setData({error:e.message,list:[]});}
    finally{this.setData({loading:false});}
  },
  onAccountAppeal() {
    wx.showModal({title:'申诉账号处置',editable:true,placeholderText:'请填写申诉理由',success:async result => {
      if (!result.confirm || !result.content?.trim()) return;
      try {
        await app.call('report',{action:'appeal',targetType:'users',targetId:this.data.user._id,reason:result.content.trim()});
        wx.showToast({title:'申诉已提交'});
        this.setData({tab:'myReports'});
        this.load();
      } catch (error) { app.showActionError(error); }
    }});
  },
  closeAccount() {
    wx.showModal({title:'注销账号？',content:'交易权限将撤销，公开资料和联系方式将清除。',success:first => {
      if (!first.confirm) return;
      wx.showModal({title:'再次确认',editable:true,placeholderText:'请输入「注销账号」',success:async second => {
        if (!second.confirm) return;
        try {
          await app.call('governance',{action:'closeAccount',confirm:true,confirmation:second.content?.trim()});
          app.rememberAccount({accountStatus:'deleted'});
          this.load();
        } catch (error) { app.showActionError(error); }
      }});
    }});
  },
  async onRead(e){try{await app.call('governance',{action:'readNotification',id:e.currentTarget.dataset.id});this.load();}catch(err){wx.showToast({title:err.message,icon:'none'});}},
  onUnblock(e){const targetId=e.currentTarget.dataset.id;wx.showModal({title:'解除拉黑？',content:'解除后可以重新报价或发送消息。',success:async r=>{if(!r.confirm)return;try{await app.call('governance',{action:'unblock',targetId});this.load();}catch(err){wx.showToast({title:err.message,icon:'none'});}}});}
});
