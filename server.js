const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const BASE_DIR = __dirname;
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || "AIzaSyDfiOzw3THPwNSQ5blVkqpVxqZY7I_ifhk";
const ASAAS_API_KEY = process.env.ASAAS_API_KEY || "$aact_prod_000MzkwODA2MWY2OGM3MWRlMDU2NWM3MzJlNzZmNGZhZGY6OmQ1ODAzYzQ0LTQ5Y2ItNGY1MC1hYWIwLWQ5YWRjYTExMTg1Zjo6JGFhY2hfYmYwYmZlMWMtYTc5Ny00MTYzLTg4YmUtNWM5NjM2MGRmNmJi";
const SUPABASE_URL = process.env.SUPABASE_URL || "https://gwafsjzlyuiifhptxoxo.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "sb_publishable_kF0ApPOjQqX6490ePvG3aw_M4dghh6Y";

// --- FUNÇÃO AUXILIAR: Salvar Pedido no Supabase ---
async function saveOrderToSupabase(orderData) {
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/pedidos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(orderData)
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.warn('Aviso ao salvar pedido no Supabase (verifique se a tabela pedidos foi criada):', resp.status, errText);
      return null;
    }
    const data = await resp.json();
    console.log('✓ Pedido registrado com sucesso no Supabase! ID:', data[0]?.id);
    return data[0];
  } catch (err) {
    console.error('Falha de conexão com Supabase:', err.message);
    return null;
  }
}

// --- FUNÇÃO AUXILIAR: Atualizar Status do Pedido no Supabase ---
async function updateOrderStatusInSupabase(asaasPaymentId, newStatus) {
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/pedidos?asaas_payment_id=eq.${encodeURIComponent(asaasPaymentId)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      },
      body: JSON.stringify({ status_pagamento: newStatus })
    });
    console.log(`Status do pedido ${asaasPaymentId} atualizado no Supabase para: ${newStatus}`);
  } catch (err) {
    console.error('Erro ao atualizar status no Supabase:', err.message);
  }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  // --- API PROXY: Places Autocomplete (New API) ---
  if (pathname === '/api/places/autocomplete') {
    const q = urlObj.searchParams.get('q');
    if (!q || q.trim().length < 2) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ suggestions: [] }));
    }

    try {
      const resp = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': GOOGLE_MAPS_KEY
        },
        body: JSON.stringify({
          input: q.trim(),
          includedRegionCodes: ['br']
        })
      });

      const data = await resp.json();
      const predictions = (data.suggestions || []).map(s => {
        const p = s.placePrediction || {};
        return {
          place_id: p.placeId,
          main_text: p.structuredFormat?.mainText?.text || p.text?.text || '',
          secondary_text: p.structuredFormat?.secondaryText?.text || ''
        };
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ predictions }));
    } catch (err) {
      console.error('Erro no autocomplete:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message, predictions: [] }));
    }
  }

  // --- API PROXY: Place Details (New API) ---
  if (pathname === '/api/places/details') {
    const placeId = urlObj.searchParams.get('id');
    if (!placeId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing placeId' }));
    }

    try {
      const fieldMask = 'id,displayName,rating,userRatingCount,formattedAddress,nationalPhoneNumber,photos,reviews';
      const resp = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
        method: 'GET',
        headers: {
          'X-Goog-Api-Key': GOOGLE_MAPS_KEY,
          'X-Goog-FieldMask': fieldMask,
          'Accept-Language': 'pt-BR'
        }
      });

      const p = await resp.json();

      let photoUrl = '';
      if (p.photos && p.photos[0] && p.photos[0].name) {
        photoUrl = `/api/places/photo?ref=${encodeURIComponent(p.photos[0].name)}`;
      }

      const reviews = (p.reviews || []).slice(0, 3).map(r => ({
        a: r.authorAttribution?.displayName || 'Cliente',
        s: r.rating || 5,
        t: r.text?.text || r.originalText?.text || '',
        w: r.relativePublishTimeDescription || ''
      }));

      const biz = {
        name: p.displayName?.text || '',
        rating: p.rating || 0,
        total: p.userRatingCount || 0,
        addr: p.formattedAddress || '',
        tel: p.nationalPhoneNumber || '',
        photo: photoUrl,
        reviews: reviews
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(biz));
    } catch (err) {
      console.error('Erro no place details:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // --- API PROXY: Photo Redirect ---
  if (pathname === '/api/places/photo') {
    const ref = urlObj.searchParams.get('ref');
    if (!ref) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Photo not found');
    }
    const targetUrl = `https://places.googleapis.com/v1/${ref}/media?maxHeightPx=300&maxWidthPx=300&key=${GOOGLE_MAPS_KEY}`;
    res.writeHead(302, { Location: targetUrl });
    return res.end();
  }

  // --- API ASAAS: Criar Cobrança Direta e QR Code Pix ---
  if (pathname === '/api/asaas/create-payment') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Method not allowed' }));
    }

    let bodyRaw = '';
    req.on('data', chunk => { bodyRaw += chunk; });
    req.on('end', async () => {
      try {
        const body = JSON.parse(bodyRaw || '{}');
        const bizName = body.bizName || 'Seu Negócio';
        const packCount = body.packCount || 1;
        const totalValue = parseFloat(body.totalValue) || 89.99;
        const billingType = body.billingType === 'PIX' ? 'PIX' : (body.billingType === 'CREDIT_CARD' ? 'CREDIT_CARD' : 'UNDEFINED');
        const freteNome = body.freteNome || 'Padrão (Grátis)';
        const customerName = (body.customerName || 'Cliente').trim();
        const customerPhone = (body.customerPhone || '').replace(/\D/g, '');
        const customerCpfCnpj = (body.customerCpfCnpj || '').replace(/\D/g, '');

        let customerId = null;

        // 1. Criar ou Vincular Cliente no Asaas se tiver CPF/CNPJ
        if (customerCpfCnpj) {
          const custPayload = {
            name: customerName,
            cpfCnpj: customerCpfCnpj,
            mobilePhone: customerPhone || undefined
          };

          if (body.address) {
            custPayload.address = body.address.rua || body.address.full || undefined;
            custPayload.addressNumber = body.address.num || undefined;
            custPayload.complement = body.address.comp || undefined;
            custPayload.province = body.address.bairro || undefined;
            if (body.address.cep) {
              custPayload.postalCode = body.address.cep.replace(/\D/g, '');
            }
          }

          try {
            let custResp = await fetch('https://api.asaas.com/v3/customers', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'access_token': ASAAS_API_KEY,
                'User-Agent': 'PlacaNFCApp'
              },
              body: JSON.stringify(custPayload)
            });
            let custData = await custResp.json();
            if (custData.id) {
              customerId = custData.id;
            } else if (custData.errors && custData.errors.some(e => e.code === 'invalid_mobilePhone')) {
              delete custPayload.mobilePhone;
              const retryResp = await fetch('https://api.asaas.com/v3/customers', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'access_token': ASAAS_API_KEY,
                  'User-Agent': 'PlacaNFCApp'
                },
                body: JSON.stringify(custPayload)
              });
              const retryData = await retryResp.json();
              if (retryData.id) {
                customerId = retryData.id;
              }
            }

            if (!customerId) {
              const searchResp = await fetch(`https://api.asaas.com/v3/customers?cpfCnpj=${customerCpfCnpj}`, {
                headers: { 'access_token': ASAAS_API_KEY, 'User-Agent': 'PlacaNFCApp' }
              });
              const searchData = await searchResp.json();
              if (searchData.data && searchData.data[0]) {
                customerId = searchData.data[0].id;
              }
            }
          } catch (custErr) {
            console.error('Erro ao cadastrar cliente no Asaas:', custErr);
          }
        }

        // 2. Se temos cliente com CPF, criamos Cobrança Direta (/v3/payments)
        if (customerId) {
          const dueDate = new Date(Date.now() + 86400000 * 2).toISOString().split('T')[0];
          const payPayload = {
            customer: customerId,
            billingType: billingType,
            value: totalValue,
            dueDate: dueDate,
            description: `${packCount}x Placa NFC Google Reviews - ${bizName} (${freteNome})`,
            postalService: false
          };

          if (billingType === 'CREDIT_CARD' && body.creditCard) {
            payPayload.creditCard = {
              holderName: (body.creditCard.holderName || customerName).trim().toUpperCase(),
              number: String(body.creditCard.number || '').replace(/\D/g, ''),
              expiryMonth: String(body.creditCard.expiryMonth || '').padStart(2, '0'),
              expiryYear: String(body.creditCard.expiryYear || '').length === 2 ? '20' + body.creditCard.expiryYear : String(body.creditCard.expiryYear || ''),
              ccv: String(body.creditCard.ccv || '').trim()
            };

            payPayload.creditCardHolderInfo = {
              name: (body.creditCard.holderName || customerName).trim(),
              email: body.customerEmail || 'contato@placanfc.com.br',
              cpfCnpj: customerCpfCnpj,
              postalCode: body.address?.cep ? body.address.cep.replace(/\D/g, '') : '06716623',
              addressNumber: body.address?.num || '1',
              addressComplement: body.address?.comp || undefined,
              phone: customerPhone || undefined,
              mobilePhone: customerPhone || undefined
            };

            if (body.installmentCount && Number(body.installmentCount) > 1) {
              payPayload.installmentCount = Number(body.installmentCount);
            }
          }

          const payResp = await fetch('https://api.asaas.com/v3/payments', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'access_token': ASAAS_API_KEY,
              'User-Agent': 'PlacaNFCApp'
            },
            body: JSON.stringify(payPayload)
          });
          const payData = await payResp.json();

          if (payData.id) {
            // Salvar no Supabase
            const orderRecord = {
              tipo_negocio: body.tipoNegocio || null,
              nome_empresa: bizName,
              rating_atual: body.bizRating != null ? Number(body.bizRating) : null,
              total_avaliacoes_atual: body.bizTotal != null ? Number(body.bizTotal) : null,
              meta_avaliacoes: body.metaVal != null ? Number(body.metaVal) : null,
              unidades: body.unidades != null ? Number(body.unidades) : null,
              clientes_dia: body.clientesDia ? String(body.clientesDia) : null,
              funcionarios: body.funcionarios ? String(body.funcionarios) : null,
              nome_cliente: customerName,
              whatsapp: customerPhone,
              cpf_cnpj: customerCpfCnpj,
              usou_endereco_negocio: !!body.usouEndNegocio,
              endereco_completo: body.address ? (body.address.full || `${body.address.rua || ''}, ${body.address.num || ''} - ${body.address.bairro || ''}, ${body.address.cidade || ''}/${body.address.uf || ''}`) : null,
              cep: body.address?.cep || null,
              rua: body.address?.rua || null,
              numero: body.address?.num || null,
              complemento: body.address?.comp || null,
              bairro: body.address?.bairro || null,
              cidade: body.address?.cidade || null,
              estado: body.address?.uf || null,
              quantidade_placas: packCount,
              tipo_frete: body.freteTipo || null,
              valor_frete: body.freteVal != null ? Number(body.freteVal) : 0,
              valor_total: totalValue,
              metodo_pagamento: billingType,
              status_pagamento: (payData.status === 'CONFIRMED' || payData.status === 'RECEIVED') ? 'CONFIRMED' : 'PENDING',
              asaas_customer_id: customerId,
              asaas_payment_id: payData.id,
              pix_copia_cola: null,
              fatura_url: payData.invoiceUrl || null
            };

            if (billingType === 'CREDIT_CARD') {
              saveOrderToSupabase(orderRecord);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({
                success: true,
                type: 'credit_card',
                status: payData.status,
                paymentId: payData.id,
                invoiceUrl: payData.invoiceUrl
              }));
            }

            let pixInfo = null;
            if (billingType === 'PIX') {
              try {
                const pixResp = await fetch(`https://api.asaas.com/v3/payments/${payData.id}/pixQrCode`, {
                  headers: { 'access_token': ASAAS_API_KEY, 'User-Agent': 'PlacaNFCApp' }
                });
                const pixData = await pixResp.json();
                if (pixData.success && pixData.payload) {
                  pixInfo = {
                    copyPaste: pixData.payload,
                    qrCodeImage: pixData.encodedImage ? `data:image/png;base64,${pixData.encodedImage}` : null,
                    expirationDate: pixData.expirationDate
                  };
                  orderRecord.pix_copia_cola = pixData.payload;
                }
              } catch (pixErr) {
                console.warn('Erro ao buscar QR code Pix:', pixErr);
              }
            }

            saveOrderToSupabase(orderRecord);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              success: true,
              type: 'direct',
              paymentId: payData.id,
              invoiceUrl: payData.invoiceUrl,
              url: payData.invoiceUrl,
              billingType: billingType,
              pix: pixInfo
            }));
          } else if (billingType === 'CREDIT_CARD' && payData.errors) {
            console.error('Erro cartão de crédito:', payData.errors);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              success: false,
              error: payData.errors[0]?.description || 'Transação não autorizada pelo cartão de crédito.'
            }));
          } else {
            console.error('Erro ao criar cobrança direta Asaas:', payData);
          }
        }

        // 3. Fallback: Link de Pagamento genérico caso não tenha CPF válido
        const linkPayload = {
          name: `${packCount}x Placa NFC Google Reviews - ${bizName}`,
          description: `Pedido de ${packCount} display(s) para ${bizName}. Frete: ${freteNome}. Cliente: ${customerName} (${customerPhone}).`,
          chargeType: 'DETACHED',
          value: totalValue,
          billingType: billingType,
          dueDateLimitDays: 3
        };

        const linkResp = await fetch('https://api.asaas.com/v3/paymentLinks', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'access_token': ASAAS_API_KEY,
            'User-Agent': 'PlacaNFCApp'
          },
          body: JSON.stringify(linkPayload)
        });

        const linkData = await linkResp.json();
        if (linkData.url) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true, type: 'link', url: linkData.url, id: linkData.id }));
        } else {
          console.error('Erro Asaas API:', linkData);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: linkData.errors?.[0]?.description || 'Erro ao gerar link de pagamento' }));
        }
      } catch (err) {
        console.error('Erro ao processar Asaas:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // --- WEBHOOK ASAAS: Notificações de Pagamento em Tempo Real ---
  if (pathname === '/api/asaas/webhook' && req.method === 'POST') {
    let bodyRaw = '';
    req.on('data', chunk => { bodyRaw += chunk; });
    req.on('end', async () => {
      try {
        const eventData = JSON.parse(bodyRaw || '{}');
        console.log('Webhook Asaas recebido:', eventData.event, eventData.payment?.id);
        const payment = eventData.payment;
        if (payment && payment.id) {
          if (eventData.event === 'PAYMENT_RECEIVED' || eventData.event === 'PAYMENT_CONFIRMED') {
            await updateOrderStatusInSupabase(payment.id, 'CONFIRMED');
          } else if (eventData.event === 'PAYMENT_REFUNDED') {
            await updateOrderStatusInSupabase(payment.id, 'REFUNDED');
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ received: true }));
      } catch (err) {
        console.error('Erro no webhook Asaas:', err);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

function generateScanQueries(q) {
  const clean = q.trim();
  const lower = clean.toLowerCase();
  
  let term = clean;
  let loc = '';
  
  if (lower.includes(' em ')) {
    const parts = clean.split(/ em /i);
    term = parts[0].trim();
    loc = parts.slice(1).join(' ').trim();
  } else if (lower.includes(' de ')) {
    const parts = clean.split(/ de /i);
    term = parts[0].trim();
    loc = parts.slice(1).join(' ').trim();
  }

  const queries = [clean];
  const tLower = term.toLowerCase();

  if (tLower.includes('oficina') || tLower.includes('mecanic') || tLower.includes('carro') || tLower.includes('auto')) {
    queries.push(
      `oficina mecânica ${loc}`,
      `auto center ${loc}`,
      `mecânica automotiva ${loc}`,
      `centro automotivo ${loc}`,
      `funilaria e pintura ${loc}`,
      `auto elétrica ${loc}`,
      `troca de óleo ${loc}`,
      `borracharia ${loc}`
    );
  } else if (tLower.includes('barbearia') || tLower.includes('barba') || tLower.includes('barber')) {
    queries.push(
      `barbearia ${loc}`,
      `corte masculino ${loc}`,
      `barba e cabelo ${loc}`,
      `salão masculino ${loc}`,
      `studio barbearia ${loc}`,
      `cabeleireiro masculino ${loc}`
    );
  } else if (tLower.includes('salão') || tLower.includes('estética') || tLower.includes('beleza') || tLower.includes('cabelo')) {
    queries.push(
      `salão de beleza ${loc}`,
      `estética facial e corporal ${loc}`,
      `clínica de estética ${loc}`,
      `manicure e unhas ${loc}`,
      `cabeleireira ${loc}`,
      `studio de beleza ${loc}`
    );
  } else if (tLower.includes('restaurante') || tLower.includes('lanch') || tLower.includes('comida') || tLower.includes('pizza') || tLower.includes('burger')) {
    queries.push(
      `restaurante ${loc}`,
      `pizzaria ${loc}`,
      `hamburgueria ${loc}`,
      `lanchonete ${loc}`,
      `churrascaria ${loc}`,
      `comida japonesa ${loc}`,
      `bar e petiscaria ${loc}`
    );
  } else if (tLower.includes('odonto') || tLower.includes('dent')) {
    queries.push(
      `clínica odontológica ${loc}`,
      `dentista ${loc}`,
      `consultório odontológico ${loc}`,
      `ortodontia ${loc}`,
      `implantes dentários ${loc}`
    );
  } else if (tLower.includes('clínica') || tLower.includes('médic') || tLower.includes('saúde') || tLower.includes('doutor')) {
    queries.push(
      `clínica médica ${loc}`,
      `consultório médico ${loc}`,
      `fisioterapia ${loc}`,
      `psicologia ${loc}`,
      `laboratório de exames ${loc}`
    );
  } else if (tLower.includes('academia') || tLower.includes('cross') || tLower.includes('fit') || tLower.includes('treino')) {
    queries.push(
      `academia de musculação ${loc}`,
      `estúdio de pilates ${loc}`,
      `crossfit ${loc}`,
      `centro de treinamento ${loc}`,
      `luta e artes marciais ${loc}`
    );
  } else if (tLower.includes('pet') || tLower.includes('vet') || tLower.includes('animal')) {
    queries.push(
      `pet shop ${loc}`,
      `clínica veterinária ${loc}`,
      `banho e tosa ${loc}`,
      `veterinário 24h ${loc}`
    );
  } else {
    queries.push(
      `${clean} centro`,
      `${clean} avenida`,
      `${clean} norte`,
      `${clean} sul`,
      `${clean} leste`,
      `${clean} oeste`
    );
  }

  return [...new Set(queries.map(s => s.trim()).filter(Boolean))];
}

  // --- API ADMIN: Text Search para Prospecção com Bounds e Paginação ---
  if (pathname === '/api/admin/places-search') {
    const q = urlObj.searchParams.get('q');
    const lowLat = urlObj.searchParams.get('lowLat');
    const lowLng = urlObj.searchParams.get('lowLng');
    const highLat = urlObj.searchParams.get('highLat');
    const highLng = urlObj.searchParams.get('highLng');
    const pageToken = urlObj.searchParams.get('pageToken');
    const deep = urlObj.searchParams.get('deep') === '1';
    const isScanFull = urlObj.searchParams.get('scan') === 'full';

    if (!q || q.trim().length < 2) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ places: [], nextPageToken: null }));
    }

    try {
      const fieldMask = 'places.id,places.displayName,places.rating,places.userRatingCount,places.formattedAddress,places.nationalPhoneNumber,places.photos,places.reviews,places.websiteUri,places.googleMapsUri,places.location,places.primaryTypeDisplayName,places.types,nextPageToken';

      // --- MODO VARREDURA COMPLETA (Multi-Consultas em Paralelo) ---
      if (isScanFull) {
        const queryList = generateScanQueries(q);
        console.log(`Disparando varredura completa (${queryList.length} sub-consultas) para: ${q}`);

        const promises = queryList.map(txtQuery => 
          fetch('https://places.googleapis.com/v1/places:searchText', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Goog-Api-Key': GOOGLE_MAPS_KEY,
              'X-Goog-FieldMask': fieldMask
            },
            body: JSON.stringify({
              textQuery: txtQuery,
              languageCode: 'pt-BR',
              maxResultCount: 20
            })
          })
          .then(r => r.json())
          .catch(err => {
            console.warn(`Erro na sub-consulta "${txtQuery}":`, err.message);
            return { places: [] };
          })
        );

        const results = await Promise.all(promises);
        const seenIds = new Set();
        const combinedPlaces = [];

        results.forEach(d => {
          (d.places || []).forEach(p => {
            if (p.id && !seenIds.has(p.id)) {
              seenIds.add(p.id);
              combinedPlaces.push(p);
            }
          });
        });

        console.log(`Varredura completa concluída! Total de empresas únicas encontradas: ${combinedPlaces.length}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ places: combinedPlaces, nextPageToken: null }));
      }

      const searchBody = {
        textQuery: q.trim(),
        languageCode: 'pt-BR',
        maxResultCount: 20
      };

      if (pageToken) {
        searchBody.pageToken = pageToken;
      } else if (lowLat && lowLng && highLat && highLng) {
        searchBody.locationRestriction = {
          rectangle: {
            low: { latitude: parseFloat(lowLat), longitude: parseFloat(lowLng) },
            high: { latitude: parseFloat(highLat), longitude: parseFloat(highLng) }
          }
        };
      }

      const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': GOOGLE_MAPS_KEY,
          'X-Goog-FieldMask': fieldMask
        },
        body: JSON.stringify(searchBody)
      });

      const data = await resp.json();
      let places = data.places || [];
      let nextToken = data.nextPageToken || null;

      // Se o usuário pediu "Busca Profunda" e há próxima página, busca automaticamente a página 2
      if (deep && nextToken && places.length > 0) {
        try {
          await new Promise(r => setTimeout(r, 2000));
          const resp2 = await fetch('https://places.googleapis.com/v1/places:searchText', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Goog-Api-Key': GOOGLE_MAPS_KEY,
              'X-Goog-FieldMask': fieldMask
            },
            body: JSON.stringify({
              textQuery: q.trim(),
              languageCode: 'pt-BR',
              pageToken: nextToken
            })
          });
          const data2 = await resp2.json();
          if (data2.places && data2.places.length > 0) {
            const seenIds = new Set(places.map(p => p.id));
            data2.places.forEach(p => {
              if (!seenIds.has(p.id)) {
                places.push(p);
                seenIds.add(p.id);
              }
            });
            nextToken = data2.nextPageToken || null;
          }
        } catch (err2) {
          console.warn('Aviso na busca profunda página 2:', err2.message);
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ places: places, nextPageToken: nextToken }));
    } catch (err) {
      console.error('Erro no places text search:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message, places: [], nextPageToken: null }));
    }
  }

  // --- Static Files Serving ---
  let reqPath = decodeURI(pathname);
  if (reqPath === '/' || reqPath === '') {
    reqPath = '/index.html';
  }

  const filePath = path.normalize(path.join(BASE_DIR, reqPath));

  if (!filePath.startsWith(BASE_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('403 Forbidden');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://localhost:${PORT}/`);
});
