Component({data:{tip:'请选择公共场所面交，先验货，勿提前转账。禁止盗版、违禁品、诈骗与骚扰。'},lifetimes:{attached(){getApp().loadConfig().then(c=>this.setData({tip:c.safetyTip})).catch(()=>{});}}});
