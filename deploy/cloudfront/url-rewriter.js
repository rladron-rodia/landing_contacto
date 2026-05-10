// CloudFront Function — viewer-request handler
// Reescribe URIs para que paths como `/admin/` resuelvan a `/admin/index.html`
// en buckets S3 servidos vía OAC (que NO auto-resuelven directory indexes).
//
// Uso: asociado al DefaultCacheBehavior del distribution `E1XWJ852NOX2OQ` como
// FunctionAssociation con EventType=viewer-request.
//
// Casos cubiertos:
//   /            -> /index.html
//   /admin/      -> /admin/index.html
//   /admin       -> /admin/index.html  (sin trailing slash, sin extension)
//   /foo.png     -> /foo.png           (con extension, no se toca)
//   /assets/css/tailwind.min.css -> sin cambios
//
function handler(event) {
    var request = event.request;
    var uri = request.uri;

    if (uri.endsWith('/')) {
        request.uri += 'index.html';
    } else if (!uri.split('/').pop().includes('.')) {
        request.uri += '/index.html';
    }

    return request;
}
