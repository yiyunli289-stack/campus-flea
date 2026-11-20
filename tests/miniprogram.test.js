'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const ts=require('typescript');
test('小程序所有注册页面文件齐全，模板事件均有对应页面方法',()=>{
  const root=path.resolve(__dirname,'../miniprogram');const app=JSON.parse(fs.readFileSync(path.join(root,'app.json'),'utf8'));
  for(const route of app.pages){
    for(const ext of ['.js','.json','.wxml','.wxss'])assert(fs.existsSync(path.join(root,route+ext)),route+ext);
    const code=fs.readFileSync(path.join(root,route+'.js'),'utf8');const source=ts.createSourceFile(route,code,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);const methods=new Set();
    function visit(node){
      if(ts.isCallExpression(node)&&node.arguments[0]&&ts.isObjectLiteralExpression(node.arguments[0])){
        const expr=node.expression;const configured=ts.isCallExpression(expr)&&expr.expression.getText(source)==='require'&&expr.arguments[0]?.getText(source).includes('/utils/page');
        if(expr.getText(source)==='Page'||configured)for(const p of node.arguments[0].properties)if(p.name)methods.add(p.name.getText(source));
      }
      ts.forEachChild(node,visit);
    }visit(source);
    const template=fs.readFileSync(path.join(root,route+'.wxml'),'utf8');
    for(const match of template.matchAll(/\b(?:bind|catch):?[a-z]+=["']([A-Za-z_]\w*)["']/g))assert(methods.has(match[1]),`${route} 模板引用了未定义的 ${match[1]}`);
  }
});
