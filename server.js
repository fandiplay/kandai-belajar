require('dotenv').config();
const express=require('express'),mysql=require('mysql2/promise'),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken'),path=require('path');
const app=express();app.use(express.json());app.use(express.static(path.join(__dirname,'public')));
const pool=mysql.createPool({host:process.env.DB_HOST||'127.0.0.1',user:process.env.DB_USER,password:process.env.DB_PASS,database:process.env.DB_NAME,connectionLimit:5});
const wrap=f=>(q,s)=>f(q,s).catch(e=>{console.error(e);s.status(500).json({error:e.message})});
const auth=(q,s,n)=>{try{q.uid=jwt.verify((q.headers.authorization||'').replace('Bearer ',''),process.env.JWT_SECRET).uid;n()}catch{s.status(401).json({error:'Belum login'})}};
const sign=id=>jwt.sign({uid:id},process.env.JWT_SECRET,{expiresIn:'30d'});

// ---------- AI (OpenAI-compatible: OpenAI, Groq, OpenRouter, xcloudhost, LLM lokal) ----------
async function ai(tool,prompt){
  const base=(process.env.AI_BASE_URL||'https://api.openai.com/v1').replace(/\/+$/,'');
  const call=async useTools=>{
    const body={model:process.env.AI_MODEL_NAME,temperature:0.7,messages:[
      {role:'system',content:'Jawab HANYA dengan JSON valid sesuai skema ini, tanpa teks lain:\n'+JSON.stringify(tool.input_schema)},
      {role:'user',content:prompt}]};
    if(useTools){body.tools=[{type:'function',function:{name:tool.name,description:tool.description,parameters:tool.input_schema}}];body.tool_choice={type:'function',function:{name:tool.name}}}
    const r=await fetch(base.endsWith('/chat/completions')?base:base+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+process.env.AI_API_KEY,'Content-Type':'application/json'},body:JSON.stringify(body)});
    return {r,d:await r.json()};
  };
  let {r,d}=await call(true);
  if(!r.ok&&r.status===400)({r,d}=await call(false)); // provider tidak mendukung tools -> mode JSON biasa
  if(!r.ok)throw new Error('AI gagal: '+JSON.stringify(d.error||d));
  const m=d.choices?.[0]?.message||{};
  const raw=m.tool_calls?.[0]?.function?.arguments||m.content||'';
  const j=raw.match(/\{[\s\S]*\}/);
  if(!j)throw new Error('AI tidak mengembalikan JSON');
  return JSON.parse(j[0]);
}
const roadmapTool={name:'create_roadmap',description:'Buat roadmap belajar',input_schema:{type:'object',required:['course_title','units'],properties:{course_title:{type:'string'},units:{type:'array',items:{type:'object',required:['title','lessons'],properties:{title:{type:'string'},lessons:{type:'array',items:{type:'string'}}}}}}}};
const lessonTool={name:'create_lesson',description:'Buat isi pelajaran: blok teks dan kuis diselang-seling',input_schema:{type:'object',required:['blocks'],properties:{blocks:{type:'array',items:{type:'object',required:['type'],properties:{type:{type:'string',enum:['text','quiz']},markdown:{type:'string'},question:{type:'string'},options:{type:'array',items:{type:'string'}},correct:{type:'integer'},explanation:{type:'string'}}}}}}};
function validLesson(b){
  if(!Array.isArray(b)||b.length<3)throw new Error('Blok kurang');
  b.forEach(x=>{
    if(x.type==='text'){if(!x.markdown)throw new Error('Teks kosong')}
    else if(x.type==='quiz'){if(!x.question||!Array.isArray(x.options)||x.options.length!==4||!Number.isInteger(x.correct)||x.correct<0||x.correct>3)throw new Error('Kuis tidak valid')}
    else throw new Error('Tipe tidak dikenal');
  });
  return b;
}

// ---------- Auth ----------
app.post('/api/register',wrap(async(q,s)=>{
  const u=String(q.body.username||'').trim(),p=String(q.body.password||'');
  if(u.length<3||u.length>40||p.length<6)return s.status(400).json({error:'Username min 3 huruf, password min 6 karakter'});
  try{const [r]=await pool.query('INSERT INTO users(username,password_hash) VALUES(?,?)',[u,bcrypt.hashSync(p,10)]);s.json({token:sign(r.insertId),username:u})}
  catch(e){if(e.code==='ER_DUP_ENTRY')return s.status(409).json({error:'Username sudah dipakai'});throw e}
}));
app.post('/api/login',wrap(async(q,s)=>{
  const [[u]]=await pool.query('SELECT * FROM users WHERE username=?',[String(q.body.username||'').trim()]);
  if(!u||!bcrypt.compareSync(String(q.body.password||''),u.password_hash))return s.status(401).json({error:'Username atau password salah'});
  s.json({token:sign(u.id),username:u.username});
}));

// ---------- Course / roadmap ----------
app.get('/api/courses',auth,wrap(async(q,s)=>{
  const [r]=await pool.query('SELECT c.id,c.title,COUNT(l.id) total,COUNT(l.completed_at) done FROM courses c LEFT JOIN lessons l ON l.course_id=c.id WHERE c.user_id=? GROUP BY c.id ORDER BY c.id DESC',[q.uid]);
  s.json(r);
}));
app.post('/api/courses',auth,wrap(async(q,s)=>{
  const p=String(q.body.prompt||'').trim().slice(0,300);
  if(!p)return s.status(400).json({error:'Topik kosong'});
  const r=await ai(roadmapTool,`Pengguna ingin belajar: "${p}". Buat roadmap belajar dalam bahasa Indonesia untuk pemula: 2-4 unit, tiap unit 3-5 pelajaran, urut dari dasar. Judul singkat.`);
  if(!Array.isArray(r.units)||!r.units.length)throw new Error('Roadmap tidak valid');
  const [c]=await pool.query('INSERT INTO courses(user_id,title,prompt) VALUES(?,?,?)',[q.uid,r.course_title,p]);
  const rows=[];r.units.forEach((u,i)=>(u.lessons||[]).forEach(t=>rows.push([c.insertId,i,u.title,t])));
  await pool.query('INSERT INTO lessons(course_id,unit_idx,unit_title,title) VALUES ?',[rows]);
  s.json({id:c.insertId});
}));
app.get('/api/courses/:id',auth,wrap(async(q,s)=>{
  const [[c]]=await pool.query('SELECT id,title FROM courses WHERE id=? AND user_id=?',[q.params.id,q.uid]);
  if(!c)return s.status(404).json({error:'Tidak ditemukan'});
  const [l]=await pool.query('SELECT id,unit_idx,unit_title,title,(completed_at IS NOT NULL) done FROM lessons WHERE course_id=? ORDER BY id',[c.id]);
  s.json({...c,lessons:l});
}));

// ---------- Lesson ----------
async function getLesson(id,uid){
  const [[l]]=await pool.query('SELECT l.*,c.title ct FROM lessons l JOIN courses c ON c.id=l.course_id WHERE l.id=? AND c.user_id=?',[id,uid]);
  return l;
}
app.post('/api/lessons/:id/open',auth,wrap(async(q,s)=>{
  const l=await getLesson(q.params.id,q.uid);if(!l)return s.status(404).json({error:'Tidak ditemukan'});
  let blocks=l.content?JSON.parse(l.content):null;
  for(let i=0;i<3&&!blocks;i++){
    try{
      const r=await ai(lessonTool,`Kursus: "${l.ct}". Unit: "${l.unit_title}". Buat pelajaran "${l.title}" dalam bahasa Indonesia yang ringan dan mudah dipahami pemula. Susun 6-8 blok: teks markdown singkat (maks 120 kata, boleh pakai contoh) diselang-seling dengan kuis pilihan ganda. Kuis selalu 4 opsi, "correct" adalah indeks 0-3, tulis "explanation" singkat. Blok pertama harus teks.`);
      blocks=validLesson(r.blocks);
    }catch(e){if(i===2)throw e}
  }
  if(!l.content)await pool.query('UPDATE lessons SET content=? WHERE id=?',[JSON.stringify(blocks),l.id]);
  s.json({id:l.id,title:l.title,blocks:blocks.map(({correct,explanation,...b})=>b)}); // kunci jawaban tidak dikirim
}));
app.post('/api/lessons/:id/answer',auth,wrap(async(q,s)=>{
  const l=await getLesson(q.params.id,q.uid);if(!l||!l.content)return s.status(404).json({error:'Tidak ditemukan'});
  const b=JSON.parse(l.content)[+q.body.quiz_idx],k=+q.body.chosen;
  if(!b||b.type!=='quiz'||!(k>=0&&k<4))return s.status(400).json({error:'Data tidak valid'});
  const ok=k===b.correct?1:0;
  await pool.query('INSERT IGNORE INTO answers(lesson_id,quiz_idx,chosen,is_correct) VALUES(?,?,?,?)',[l.id,+q.body.quiz_idx,k,ok]); // jawaban pertama yang dihitung
  s.json({is_correct:!!ok,correct:b.correct,explanation:b.explanation||''});
}));
app.post('/api/lessons/:id/complete',auth,wrap(async(q,s)=>{
  const l=await getLesson(q.params.id,q.uid);if(!l||!l.content)return s.status(404).json({error:'Tidak ditemukan'});
  const total=JSON.parse(l.content).filter(b=>b.type==='quiz').length;
  const [[a]]=await pool.query('SELECT COALESCE(SUM(is_correct),0) sc FROM answers WHERE lesson_id=?',[l.id]);
  await pool.query('UPDATE lessons SET completed_at=COALESCE(completed_at,NOW()),score=? WHERE id=?',[+a.sc,l.id]);
  s.json({score:+a.sc,total});
}));

app.listen(process.env.PORT||3000,()=>console.log('Jalan di http://localhost:'+(process.env.PORT||3000)));
