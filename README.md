# TU CUMPA — CNXieku

Actor de extracción de un producto CNXieku por URL. Devuelve un único registro
JSON en el Dataset predeterminado de cada run y conserva el último resultado
válido en `cnxieku-results/RESULT`.

Usa Apify SDK y Cheerio de la dependencia Crawlee existente. Consulta la ficha
real mediante HTTPS, sin navegador, proxy ni descarga de imágenes.

## Entrada

El formulario solicita únicamente la URL del producto y el formato de salida:

```json
{
  "url": "https://www.cnxieku.com/item/20354",
  "outputFormat": "reference1688"
}
```

| Campo | Uso |
| --- | --- |
| `url` | Obligatorio. `https://www.cnxieku.com/item/<ID>`, sin parámetros ni fragmento. |
| `outputFormat` | `canonical` (predeterminado) o `reference1688`. |

Se rechazan los campos adicionales. Las entradas antiguas deben actualizarse a
este contrato; ya no se admite `mode`, `query`, `maxResults` ni `source`.

Los límites HTTP conservan sus valores predeterminados: plazo total de 30 s y
2 MiB por respuesta. Se pueden ajustar mediante las variables de entorno
`CNXIEKU_TIMEOUT_SECS` (entero de 1 a 60) y `CNXIEKU_MAX_RESPONSE_BYTES`
(entero de 1024 a 2097152), sin añadir campos al formulario.

## JSON de cada ejecución

El Actor llama una sola vez a `Actor.pushData()` para guardar el registro
completo de la ejecución en su Dataset predeterminado. Las imágenes y variantes
permanecen dentro de `data`; no se generan filas independientes para ellas.

La estructura conserva los metadatos y el producto:

```json
{
  "schemaVersion": 1,
  "source": "cnxieku",
  "mode": "product",
  "outputFormat": "reference1688",
  "status": "partial",
  "updatedAt": "2026-10-30T12:00:00.000Z",
  "runId": "ID_DEL_RUN",
  "data": {
    "url": "https://www.cnxieku.com/item/20354",
    "title": null,
    "price": null,
    "productLadderPrices": [],
    "moq": null,
    "weight": null,
    "dimensions": null,
    "images": null,
    "characteristics": null,
    "variations": null,
    "productId": 20354
  }
}
```

Este ejemplo ilustra el contrato; no representa una extracción real.
`reference1688` conserva exactamente estos once campos dentro de `data`:
`url`, `title`, `price`, `productLadderPrices`, `moq`, `weight`, `dimensions`,
`images`, `characteristics`, `variations` y `productId`.

Con `canonical`, `data` contiene `requestedUrl`, `source`, `mode`, `status`,
`httpStatus`, `product`, `missingFields` y `error`. Los valores no disponibles
permanecen como `null`; no se inventan moneda, precios escalonados ni imágenes
de SKU. `partial` indica una extracción válida con campos faltantes.

Los esquemas de [Dataset](https://docs.apify.com/storage/dataset-schema) y
[Output](https://docs.apify.com/actors/development/actor-definition/output-schema)
están referenciados desde `.actor/actor.json`. La salida principal **JSON de
esta ejecución** apunta directamente al Dataset del run, con el objeto `data`
visible en la vista de Results/Output.

## Último resultado válido

El Key-value Store nombrado **`cnxieku-results`**, registro **`RESULT`**, conserva
el último producto válido entre runs. Un resultado `success` o `partial`
reemplaza ese registro con el mismo objeto que se publica en el Dataset.
Un error de entrada, red, bloqueo o análisis conserva el último válido.

El Dataset pertenece al run actual. El registro persistente puede proceder de
una ejecución anterior; nunca se copia ese resultado anterior al Dataset como
si fuera una extracción nueva. Si aún no hubo un resultado válido, `RESULT`
no existe.

El bloqueo de escritura existente se mantiene: la cola nombrada
`cnxieku-results-writer` permite un solo escritor en Cloud. Si otro run posee el
bloqueo, se devuelve `RESULT_BUSY`, sin consultar la fuente ni cambiar `RESULT`.
El bloqueo dura 300 s, se renueva antes de publicar y se libera al terminar o
abortar; tras una caída expira automáticamente. Las escrituras persistentes
tienen timeout de 15 s y no se reintentan.

Se puede consultar el último válido en **Storage → Key-value stores →
cnxieku-results → RESULT**. La salida secundaria **Último RESULT válido
(referencia)** abre `RESULT_LOCATION`, con `apiUrl` y `consoleUrl` del almacén.
El acceso conserva los permisos habituales del almacén.

## Errores y diagnósticos

Un fallo manejado genera una única fila con `status` igual a `not_found`,
`blocked`, `timeout` o `error`. Incluso si se pidió `reference1688`, en ese caso
`data` contiene el diagnóstico canonical: `data.error.code`,
`data.error.message`, `data.httpStatus`, la URL validada y un producto vacío.
El run termina con código 1; no se interpreta esa fila como un producto válido.

En el Key-value Store predeterminado del run quedan:

- `LAST_ERROR`: diagnóstico del fallo, cuando lo hay.
- `RUN_STATE`: estado, `savedResults` (0 o 1 resultados válidos persistidos),
  `datasetItems` (0 o 1 registros escritos) y estado de extracción.
- `TIMINGS`: solicitudes HTTP, tiempos y estado de respuesta.
- `RESULT_LOCATION`: referencia al almacén persistente.

Un fallo del propio almacenamiento puede impedir publicar la fila o los
diagnósticos; el run termina fallido y registra el error en sus logs. Si falla
el Dataset después de guardar `RESULT`, ese último producto válido se conserva
y el run permanece fallido. Una ejecución abortada persiste su estado y sale
sin publicar resultados pendientes.

Se conservan las validaciones de URL, DNS público, IP remota y TLS, junto con
cero redirecciones y cero reintentos HTTP. CAPTCHA, 403 y 429 detienen la
operación. Un cambio de estructura Nuxt produce un error explícito.

## Verificar en Apify Cloud

1. En el Actor existente conectado a GitHub, comprobar que el build de `main`
   incluye el commit nuevo y finaliza correctamente. Si no se inició
   automáticamente, lanzar el build desde la integración GitHub de ese Actor.
2. Ejecutar ese build con una URL real y `outputFormat: "reference1688"`.
3. Abrir **Runs → ejecución → Results/Output → JSON de esta ejecución**.
   Debe aparecer un solo registro con los metadatos y los once campos en `data`.
   Usar la vista JSON o la exportación JSON del Dataset para leer el objeto
   completo. La respuesta del endpoint `/items?format=json` es un array con
   ese único registro.
4. Confirmar `status: "success"` o `"partial"`, `runId` del run actual y el
   mismo objeto en `cnxieku-results/RESULT`.
5. Ante un run fallido, revisar su fila de diagnóstico, logs y `LAST_ERROR`;
   `RESULT` debe seguir conteniendo el último válido.

Los archivos locales de `storage/` no se sincronizan con Console. Solo una
ejecución en Cloud confirma el resultado del build publicado.

## Desarrollo

Node.js 24 y las dependencias existentes del proyecto. Para las comprobaciones
rápidas de sintaxis y esquemas:

```powershell
npm run check
apify validate-schema
```

Para ejecutar localmente cuando se quiera comprobar una extracción real:

```powershell
apify run --no-purge --input-file input.product.json
```

La publicación se realiza mediante la conexión GitHub del Actor existente.
No es necesario ejecutar `apify push`. Se conservan Dockerfile, dependencias,
licencia ISC y el mecanismo de persistencia y cancelación existente.
