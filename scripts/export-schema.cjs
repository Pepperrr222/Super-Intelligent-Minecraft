const fs = require('node:fs');
const path = require('node:path');
import('../dist/src/schema.js').then(({actionJsonSchema,queryJsonSchema}) => {
  const target=path.join(__dirname,'../docs/actions.schema.json');
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,JSON.stringify(actionJsonSchema,null,2)+'\n');
  fs.writeFileSync(path.join(__dirname,'../docs/queries.schema.json'),JSON.stringify(queryJsonSchema,null,2)+'\n');
  console.log('已导出 docs/actions.schema.json');
});
