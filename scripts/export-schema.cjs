const fs = require('node:fs');
const path = require('node:path');
Promise.all([import('../dist/src/schema.js'), import('../dist/src/basic-operations.js'),import('../dist/src/stage-plan.js')]).then(([{actionJsonSchema,queryJsonSchema,basicOperationJsonSchema,inputJsonSchema},{operationCatalog},{stagePlanSchema}]) => {
  const target=path.join(__dirname,'../docs/actions.schema.json');
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,JSON.stringify(actionJsonSchema,null,2)+'\n');
  fs.writeFileSync(path.join(__dirname,'../docs/queries.schema.json'),JSON.stringify(queryJsonSchema,null,2)+'\n');
  fs.writeFileSync(path.join(__dirname,'../docs/operations.schema.json'),JSON.stringify(basicOperationJsonSchema,null,2)+'\n');
  fs.writeFileSync(path.join(__dirname,'../docs/stage-plan.schema.json'),JSON.stringify(inputJsonSchema(stagePlanSchema),null,2)+'\n');
  const versions=['1.21.1','1.21.6'];
  const catalogs=versions.map(version=>operationCatalog(version));
  const rows=basicOperationJsonSchema.oneOf.map(schema=>{
    const type=schema.properties.type.const;
    const params=Object.entries(schema.properties).filter(([key])=>key!=='type').map(([key,value])=>
      key+(schema.required?.includes(key)?'':'?')+('default' in value?'='+JSON.stringify(value.default):'')).join(', ') || '无';
    const states=catalogs.map(catalog=>{const card=catalog.find(entry=>entry.type===type);return card.available?'可调用（未实机验收）':card.reason;});
    return '|'+[type,params,...states].join('|')+'|';
  });
  fs.writeFileSync(path.join(__dirname,'../docs/operation-catalog.md'),[
    '# 模型操作完整目录（生成）','','由 pnpm schema 从原生 Schema 派生的操作定义和版本目录生成，不手工编辑。',
    '44 种原生动作各有一个操作入口；可调用不代表前置条件已满足或已实机通过。参数细节查 operations.schema.json 或 operation_schema 查询。',
    'craft 的 count 与 repetitions 必须二选一；? 表示可省略。引用、窗口与证据边界见 basic-operations.md。','',
    '|type|参数|1.21.1|1.21.6|','|---|---|---|---|',...rows,'',
  ].join('\n'));
  console.log('已导出 docs/actions.schema.json');
});
