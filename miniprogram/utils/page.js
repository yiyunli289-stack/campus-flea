// Wait for the published dictionary before initializing a page. Cached dictionaries are display-only.
module.exports=function configuredPage(definition) {
  const load=definition.onLoad;const show=definition.onShow;
  definition.onLoad=function(query){
    this._configured=getApp().loadConfig().catch(()=>null).then(()=>{
      const c=getApp().globalData.config;
      if(c){const patch={};const codes=key=>(c[key]||[]).filter(x=>x.active).map(x=>x.code);
        for(const [field,key] of [['conditions','conditions'],['noteLevels','noteLevels'],['campusList','campuses'],['colleges','colleges']])if(Object.prototype.hasOwnProperty.call(this.data,field))patch[field]=codes(key);
        for(const [field,key,all] of [['campusOptions','campuses','全部校区'],['collegeOptions','colleges','全部学院'],['conditionOptions','conditions','全部成色']])if(Object.prototype.hasOwnProperty.call(this.data,field))patch[field]=[all].concat(codes(key));
        this.setData(patch);
      }
      return load&&load.call(this,query);
    });
  };
  definition.onShow=function(){(this._configured||Promise.resolve()).then(()=>show&&show.call(this));};
  return Page(definition);
};
