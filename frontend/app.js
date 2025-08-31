// ===== Config =====
const API_BASE = window.API_URL || "http://127.0.0.1:8000";

// ===== State names + fallback tax data (minimal) =====
const STATE_NAMES = {AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",DC:"District of Columbia",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming"};
const STATE_TAX_FALLBACK = {states:Object.keys(STATE_NAMES),no_tax:["AK","FL","NV","SD","TN","TX","WA","WY","NH"],flat_rates:{"CO":0.044,"IL":0.0495,"IN":0.0315,"KY":0.04,"MA":0.05,"MI":0.0425,"NC":0.045,"PA":0.0307,"UT":0.0465},progressive:{},federal:{single:[[0,0.10],[11600,0.12],[47150,0.22],[100525,0.24],[191950,0.32],[243725,0.35],[609350,0.37]],married_joint:[[0,0.10],[23200,0.12],[94300,0.22],[201050,0.24],[383900,0.32],[487450,0.35],[731200,0.37]],head_of_household:[[0,0.10],[16550,0.12],[63100,0.22],[100500,0.24],[191950,0.32],[243700,0.35],[609350,0.37]],},standard_deduction:{single:14600,married_joint:29200,head_of_household:21900}};
let STATE_TAX = null;

// ===== Helpers =====
function lockInput(input, locked, placeholder = ""){
  input.readOnly=!!locked; input.disabled=false;
  if(placeholder) input.placeholder=placeholder;
  input.classList.toggle("bg-gray-100",locked);
  input.classList.toggle("cursor-not-allowed",locked);
  input.classList.toggle("opacity-70",locked);
}
function showModal(html){const m=document.getElementById("taxModal");const b=document.getElementById("taxModalBody");if(!m||!b)return;b.innerHTML=html;m.classList.remove("hidden");m.classList.add("flex");}
function hideModal(){const m=document.getElementById("taxModal");if(!m)return;m.classList.add("hidden");m.classList.remove("flex");}
document.addEventListener("click",(e)=>{if(e.target.id==="taxModalClose"||e.target.id==="taxModalOk"||e.target.id==="taxModal")hideModal();});

// ===== Presets =====
const PRESETS={conventional:{front:0.28,back:0.36},fha:{front:0.31,back:0.43},va:{front:0.00,back:0.41},custom:null};
function applyPreset(name){
  const p=PRESETS[name]; if(!p) return;
  const fe=document.getElementById("front_end");
  const be=document.getElementById("back_end");
  if(!fe||!be) return;
  fe.value=p.front.toFixed(2); be.value=p.back.toFixed(2);
  [fe,be].forEach(el=>{el.classList.add("ring-2","ring-blue-400");setTimeout(()=>el.classList.remove("ring-2","ring-blue-400"),500);});
}

// ===== State select =====
function populateStateDropdown(){
  const sel=document.getElementById("state_code"); if(!sel) return;
  sel.innerHTML=""; const opt=document.createElement("option"); opt.value=""; opt.textContent="Use flat rate"; sel.appendChild(opt);
  const codes=(STATE_TAX&&Array.isArray(STATE_TAX.states)&&STATE_TAX.states.length)?[...STATE_TAX.states]:Object.keys(STATE_NAMES);
  codes.map(c=>({code:c,name:STATE_NAMES[c]||c})).sort((a,b)=>a.name.localeCompare(b.name)).forEach(({code,name})=>{
    const o=document.createElement("option"); o.value=code; o.textContent=name; sel.appendChild(o);
  });
}
function setupStateBehavior(){
  const sel=document.getElementById("state_code");
  const rate=document.getElementById("state_rate");
  if(!sel||!rate) return;
  function refresh(){
    const code=sel.value;
    if(!code){ rate.value=""; lockInput(rate,false,"Enter flat rate (e.g., 0.05)"); return; }
    const noTax=(STATE_TAX?.no_tax||[]).includes(code);
    const flatVal=STATE_TAX?.flat_rates?.[code];
    if(noTax){ rate.value=""; lockInput(rate,true,"No state income tax"); return; }
    if(typeof flatVal==="number"){ rate.value=flatVal; lockInput(rate,true,"Flat state rate auto-filled"); return; }
    lockInput(rate,true,"Progressive brackets used");
    rate.value="";
  }
  sel.addEventListener("change",refresh); refresh();
}

// ===== Tax breakdown helpers (simplified) =====
function progressiveBreakdown(gross, filing, brackets, std){
  const taxable=Math.max(0,gross-(std||0)); const rows=[]; let prev=0; let total=0;
  for(let i=0;i<brackets.length;i++){ const [min,rate]=brackets[i]; const next=(i+1<brackets.length)?brackets[i+1][0]:null;
    const lower=Math.max(prev,min); const upper=(next===null)?taxable:Math.min(taxable,next);
    if(upper>lower){ const amt=upper-lower; const tax=amt*rate; rows.push({range:`${lower.toLocaleString()}–${upper.toLocaleString()}`, rate:`${(rate*100).toFixed(1)}%`, amount:amt, tax}); total+=tax; }
    prev=next??prev;
    if(next!==null && taxable<=next) break;
  }
  return {rows,total};
}
function renderBreakdownHTML({mode,code,filingStatus,grossIncome,standardDeduction,flatRate,brackets,result}){
  const header=`<div class="mb-2"><div><span class="font-medium">State:</span> ${code||"(manual flat)"} </div><div><span class="font-medium">Filing:</span> ${filingStatus.replaceAll("_"," ")} </div><div><span class="font-medium">Gross income:</span> $ ${grossIncome.toLocaleString()}</div></div>`;
  if(mode==="no_tax") return header+`<div class="p-3 bg-green-50 border border-green-200 rounded">No state income tax.</div>`;
  if(mode==="flat"||mode==="flat_manual") return header+`<div class="p-3 bg-blue-50 border border-blue-200 rounded">Flat rate: ${(flatRate*100).toFixed(2)}%.</div>`;
  const rows=result?.rows||[];
  const table=rows.map(r=>`<div class="grid grid-cols-3 text-xs"><div>${r.range}</div><div>${r.rate}</div><div>$ ${r.tax.toLocaleString()}</div></div>`).join("");
  return header+`
    <div class="border rounded p-2">
      <div class="grid grid-cols-3 text-xs font-medium mb-1"><div>Bracket</div><div>Rate</div><div>Tax</div></div>
      ${table}
      <div class="mt-2 text-right font-medium">Total: $ ${(result?.total||0).toLocaleString()}</div>
    </div>`;
}

// ===== API =====
async function postJSON(url,payload){
  const r=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
  if(!r.ok) throw new Error(await r.text()); return await r.json();
}

// ===== Form wiring =====
function wireForm(){
  document.querySelectorAll(".preset-btn").forEach(btn=>btn.addEventListener("click",(e)=>{
    e.preventDefault(); const which=btn.getAttribute("data-preset"); if(which!=="custom") applyPreset(which);
  }));
  const form=document.getElementById("calcForm"); if(!form) return;
  form.addEventListener("submit", async (e)=>{
    e.preventDefault();
    const annual_income=Number(document.getElementById("annual_income").value);
    const filing_status=document.getElementById("filing_status").value;
    const adults=Math.max(1, Number(document.getElementById("adults").value));
    const kids=Math.max(0, Number(document.getElementById("kids").value));
    let state_code=document.getElementById("state_code").value; if(!state_code) state_code=null;
    const state_rate=Number(document.getElementById("state_rate").value);
    const use_takehome=document.getElementById("use_net_dti").checked;
    const other_debt=Number(document.getElementById("other_debt").value);
    const rate_annual=Number(document.getElementById("rate_annual").value);
    const term_years=Number(document.getElementById("term_years").value);
    const ti_monthly=Number(document.getElementById("ti_monthly").value);
    const front_end=Number(document.getElementById("front_end").value);
    const back_end=Number(document.getElementById("back_end").value);
    try{
      const tax=await postJSON(`${API_BASE}/api/calc/tax`,{annual_income,filing_status,state_rate,state_code});
      const budget=await postJSON(`${API_BASE}/api/calc/budget`,{monthly_takehome:tax.monthly_takehome,adults,kids});
      const baseCosts = Object.entries(budget.allocations||{}).filter(([k])=>k!=="savings").reduce((s,[,v])=>s+Number(v||0),0);
      const surplusBeforeMortgage = Math.max(0, tax.monthly_takehome - baseCosts);
      const borrow=await postJSON(`${API_BASE}/api/calc/borrow`,{
        annual_income,other_monthly_debt:other_debt,rate_annual,term_years,taxes_insurance_monthly:ti_monthly,
        front_end_ratio:front_end,back_end_ratio:back_end,use_takehome,monthly_takehome:use_takehome?tax.monthly_takehome:null,
        surplus_limit: surplusBeforeMortgage
      });

      const resultsEl=document.getElementById("results");
      const stateLineHTML=`<button id="stateTaxBreakdownBtn" class="underline text-blue-600 hover:text-blue-800">$${tax.state_tax.toLocaleString()}</button> ${state_code ? `(state ${state_code})` : `(flat)`}`;

      const order=["housing","transportation","food","insurance_pensions","healthcare","entertainment","cash_contributions","apparel","education","miscellaneous","savings"];
      const budgetHTML=order.filter(k=>k in (budget.allocations||{})).map(k=>`<div class="contents"><div>${k.replaceAll("_"," ")}</div><div>$ ${Number((budget.allocations||{})[k]||0).toLocaleString()}</div></div>`).join("");

      const usedPI=Number(borrow.monthly_PI_used||0);
      const usedPrincipal=Number(borrow.max_principal_used||0);
      const dtiPI=Number(borrow.monthly_PI_dti||0);
      const dtiPrincipal=Number(borrow.max_principal_dti||0);
      const surPI=Number(borrow.monthly_PI_surplus||0);
      const surPrincipal=Number(borrow.max_principal_surplus||0);
      const capReason=borrow.limit_reason||"dti";

      const totalCosts = baseCosts + usedPI;
      const cashflow = tax.monthly_takehome - totalCosts;
      const cashLabel=cashflow>=0?"Surplus":"Deficit";
      const cashClass=cashflow>=0?"text-green-700 bg-green-50 border-green-200":"text-red-700 bg-red-50 border-red-200";

      resultsEl.innerHTML = `
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="bg-white p-4 rounded shadow card-compare">
            <div class="flex items-center justify-between mb-2">
              <h2 class="font-semibold">Affordability (Compare)</h2>
              <span class="badge badge-amber">dual result</span>
            </div>
            <div class="grid grid-cols-2 gap-2 text-sm">
              <div>Max P&amp;I (DTI-only):</div><div>$ ${dtiPI.toLocaleString()}</div>
              <div>Max Principal (DTI-only):</div><div>$ ${dtiPrincipal.toLocaleString()}</div>
              <div>Max P&amp;I (Budget surplus):</div><div>$ ${surPI.toLocaleString()}</div>
              <div>Max Principal (Budget surplus):</div><div>$ ${surPrincipal.toLocaleString()}</div>
            </div>
          </div>
          <div class="bg-white p-4 rounded shadow card-reco">
            <div class="flex items-center justify-between mb-2">
              <h2 class="font-semibold">Recommended (Conservative)</h2>
              <span class="badge badge-green">limited by ${capReason}</span>
            </div>
            <div class="grid grid-cols-2 gap-2 text-sm">
              <div>Monthly P&amp;I (used):</div><div class="font-medium">$ ${usedPI.toLocaleString()}</div>
              <div>Max Principal (used):</div><div class="font-medium">$ ${usedPrincipal.toLocaleString()}</div>
              <div>Assumptions:</div><div>${(rate_annual*100).toFixed(2)}% @ ${term_years} yrs; Income basis: ${borrow.assumptions.income_basis}</div>
            </div>
          </div>
        </div>

        <div class="bg-white p-4 rounded shadow card-accent">
          <h2 class="font-semibold mb-2">Income, Taxes &amp; Survival Budget</h2>
          <div class="grid grid-cols-2 gap-2 text-sm">
            <div>Federal tax:</div><div>$ ${tax.federal.federal_tax.toLocaleString()}</div>
            <div>State tax:</div><div>${stateLineHTML}</div>
            <div>Monthly take-home:</div><div class="font-medium">$ ${tax.monthly_takehome.toLocaleString()}</div>
          </div>
          <div class="mt-3">
            <div class="font-medium mb-1">Survival budget (monthly)</div>
            <div class="grid grid-cols-2 gap-2 text-sm">${budgetHTML}</div>
          </div>
        </div>

        <div class="bg-white p-4 rounded shadow">
          <h2 class="font-semibold mb-2">Cash Flow After Costs</h2>
          <div class="grid grid-cols-2 gap-2 text-sm mb-2">
            <div>Monthly take-home:</div><div>$ ${tax.monthly_takehome.toLocaleString()}</div>
            <div>Total budget (excl. savings):</div><div>$ ${baseCosts.toLocaleString()}</div>
            <div>Surplus before mortgage:</div><div class="text-green-700">$ ${surplusBeforeMortgage.toLocaleString()}</div>
            <div>Mortgage P&amp;I (used):</div><div>$ ${usedPI.toLocaleString()}</div>
            <div class="font-medium">Total monthly costs:</div><div class="font-medium">$ ${totalCosts.toLocaleString()}</div>
          </div>
          <div class="border rounded px-3 py-2 ${cashClass}">
            <div class="flex items-center justify-between">
              <span class="font-semibold">${cashLabel}</span>
              <span class="font-bold">$ ${cashflow.toLocaleString()}</span>
            </div>
            <p class="text-xs mt-1 text-gray-600">We cap P&amp;I by the lower of your DTI cap and your pre-mortgage surplus.</p>
          </div>
        </div>
      `;

      // Modal binding
      const btn=document.getElementById("stateTaxBreakdownBtn");
      if(btn){
        btn.addEventListener("click",(ev)=>{
          ev.preventDefault();
          let mode="progressive"; let flatRate=null; const code = state_code;
          if(code===null) mode="flat_manual";
          else if((STATE_TAX?.no_tax||[]).includes(code)) mode="no_tax";
          else if(typeof STATE_TAX?.flat_rates?.[code]==="number"){ mode="flat"; flatRate=STATE_TAX.flat_rates[code]; }
          const std=(STATE_TAX?.standard_deduction||{})[filing_status]||0;
          let html="";
          if(mode==="no_tax"){ html=renderBreakdownHTML({mode,code,filingStatus:filing_status,grossIncome:annual_income}); }
          else if(mode==="flat"||mode==="flat_manual"){
            const rateUse=(mode==="flat")?flatRate:state_rate;
            html=renderBreakdownHTML({mode,code,filingStatus:filing_status,grossIncome:annual_income,flatRate:rateUse});
          }else{
            const brackets=(((STATE_TAX||{}).progressive||{})[code]||{})[filing_status]||[];
            const result=progressiveBreakdown(annual_income,filing_status,brackets,std);
            html=renderBreakdownHTML({mode,code,filingStatus:filing_status,grossIncome:annual_income,standardDeduction:std,brackets,result});
          }
          showModal(html);
        });
      }
    }catch(err){ console.error(err); alert("Error: "+err.message); }
  });
}

// ===== Boot =====
document.addEventListener("DOMContentLoaded", async ()=>{
  try{
    const res=await fetch(`${API_BASE}/state_tax`);
    if(!res.ok) throw new Error(await res.text());
    STATE_TAX=await res.json();
  }catch(e){
    console.warn("Falling back to default state tax data:",e);
    STATE_TAX=STATE_TAX_FALLBACK;
  }finally{
    populateStateDropdown(); setupStateBehavior();
    document.querySelectorAll(".preset-btn").forEach(btn=>btn.addEventListener("click",(e)=>{e.preventDefault();const which=btn.getAttribute("data-preset"); if(which!=="custom") applyPreset(which);}));
    wireForm();
  }
});
