> ⚠️ **NOTA DE ARCHIVO HISTÓRICO**
>
> Este documento es el **plan original de la migración Render → AWS** (generado 2026-05-08).
> El stack final implementado tiene diferencias con este plan en algunos puntos:
>
> | Plan original | Realidad implementada |
> |---|---|
> | Email: Gmail SMTP con App Password | **Resend** con dominio `monoulabs.ai` verificado (DKIM) — transitorio, migra a **AWS SES** en v3.1.0 |
> | Bastion EC2 t4g.nano para acceso a RDS | **SSM port forwarding** — no se creó bastion |
> | CI/CD: CodePipeline + CodeBuild + CodeDeploy | **`deploy.sh` + SSM Run Command** desde Mac |
> | ADMIN_TOKEN en Parameter Store SecureString | **Secrets Manager** con KMS custom key |
>
> **Source of truth operacional:** [`AWS-DEPLOY.md`](../AWS-DEPLOY.md) en la raíz del repo.
> **Entregable formal:** [`MIGRACION-AWS-ENTREGABLE.pdf`](MIGRACION-AWS-ENTREGABLE.pdf) en este mismo directorio.
> **Estado final del stack:** account `325907670798`, region `us-east-1`. Render suspended el 2026-05-10.
>
> Se conserva este archivo como referencia histórica del proceso de planning.

---

