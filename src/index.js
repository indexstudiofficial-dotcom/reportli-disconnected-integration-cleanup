// ============================================================
// REPORTLI AI
// DISCONNECTED INTEGRATION CLEANUP WORKER
// ============================================================

// ============================================================
// CONFIGURATION
// ============================================================

const SUPABASE_TABLE = "user_integrations";

const COMPOSIO_DELETE_URL =
  "https://backend.composio.dev/api/v3.1/connected_accounts";

const BATCH_SIZE = 1000;

// ============================================================
// MAIN WORKER
// ============================================================

export default {
  async fetch(request, env) {

    // --------------------------------------------------------
    // CORS
    // --------------------------------------------------------

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders()
      });
    }

    if (request.method !== "POST") {
      return json({
        success: false,
        error: "POST method required"
      }, 405);
    }

    try {

      // ------------------------------------------------------
      // VALIDATE ENVIRONMENT VARIABLES
      // ------------------------------------------------------

      if (
        !env.SUPABASE_URL ||
        !env.SUPABASE_SERVICE_ROLE_KEY ||
        !env.COMPOSIO_API_KEY
      ) {
        throw new Error("Missing required environment variables.");
      }

      // ------------------------------------------------------
      // FETCH ALL DISCONNECTED ROWS
      // ------------------------------------------------------

      const disconnectedRows = [];

      let offset = 0;

      while (true) {

        const url = new URL(
          `${env.SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}`
        );

        url.searchParams.set("select", "*");
        url.searchParams.set("status", "eq.Disconnected");
        url.searchParams.set("order", "id.asc");

        const response = await fetch(url.toString(), {
          headers: {
            "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            "Range-Unit": "items",
            "Range": `${offset}-${offset + BATCH_SIZE - 1}`
          }
        });

        if (!response.ok) {
          throw new Error(
            `Supabase fetch failed: ${await response.text()}`
          );
        }

        const rows = await response.json();

        disconnectedRows.push(...rows);

        if (rows.length < BATCH_SIZE) {
          break;
        }

        offset += BATCH_SIZE;
      }

      // ------------------------------------------------------
      // NO DISCONNECTED ROWS
      // ------------------------------------------------------

      if (disconnectedRows.length === 0) {
        return json({
          success: true,
          processed: false,
          message: "No disconnected integrations found.",
          total_found: 0,
          composio_deleted: 0,
          database_deleted: 0,
          failed: 0
        });
      }

      // ------------------------------------------------------
      // PROCESS ALL DISCONNECTED ROWS
      // ------------------------------------------------------

      let composioDeleted = 0;
      let alreadyMissing = 0;
      let databaseDeleted = 0;
      let failed = 0;

      const results = [];

      for (const integration of disconnectedRows) {

        try {

          // --------------------------------------------------
          // RECHECK CURRENT DATABASE ROW
          // --------------------------------------------------

          const checkUrl = new URL(
            `${env.SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}`
          );

          checkUrl.searchParams.set("select", "*");
          checkUrl.searchParams.set("id", `eq.${integration.id}`);

          const checkResponse = await fetch(checkUrl.toString(), {
            headers: {
              "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
            }
          });

          if (!checkResponse.ok) {
            throw new Error(
              `Supabase recheck failed: ${await checkResponse.text()}`
            );
          }

          const latestRows = await checkResponse.json();

          if (latestRows.length === 0) {
            results.push({
              id: integration.id,
              result: "already_deleted"
            });

            continue;
          }

          const latest = latestRows[0];

          // --------------------------------------------------
          // CHECK STATUS AGAIN
          // --------------------------------------------------

          if (latest.status !== "Disconnected") {
            results.push({
              id: latest.id,
              result: "skipped",
              reason: "Integration is no longer disconnected"
            });

            continue;
          }

          // --------------------------------------------------
          // DELETE CONNECTION FROM COMPOSIO
          // --------------------------------------------------

          if (latest.connection_id) {

            const composioResponse = await fetch(
              `${COMPOSIO_DELETE_URL}/${encodeURIComponent(latest.connection_id)}?revoke_on_delete=true`,
              {
                method: "DELETE",
                headers: {
                  "x-api-key": env.COMPOSIO_API_KEY,
                  "Content-Type": "application/json"
                }
              }
            );

            if (composioResponse.status === 404) {

              // Connection is already absent from Composio.
              alreadyMissing++;

            } else if (!composioResponse.ok) {

              const errorText = await composioResponse.text();

              throw new Error(
                `Composio deletion failed (${composioResponse.status}): ${errorText}`
              );

            } else {

              composioDeleted++;

            }
          }

          // --------------------------------------------------
          // DELETE ROW FROM SUPABASE
          // --------------------------------------------------

          const deleteUrl = new URL(
            `${env.SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}`
          );

          deleteUrl.searchParams.set("id", `eq.${latest.id}`);
          deleteUrl.searchParams.set("status", "eq.Disconnected");

          if (latest.connection_id) {
            deleteUrl.searchParams.set(
              "connection_id",
              `eq.${latest.connection_id}`
            );
          } else {
            deleteUrl.searchParams.set(
              "connection_id",
              "is.null"
            );
          }

          const deleteResponse = await fetch(deleteUrl.toString(), {
            method: "DELETE",
            headers: {
              "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
              "Prefer": "return=representation"
            }
          });

          if (!deleteResponse.ok) {
            throw new Error(
              `Supabase deletion failed: ${await deleteResponse.text()}`
            );
          }

          const deletedRows = await deleteResponse.json();

          if (deletedRows.length > 0) {

            databaseDeleted++;

            results.push({
              id: latest.id,
              integration: latest.integration_id,
              result: "deleted"
            });

          } else {

            results.push({
              id: latest.id,
              integration: latest.integration_id,
              result: "skipped",
              reason: "Row changed or was already deleted"
            });

          }

        } catch (error) {

          // --------------------------------------------------
          // RECORD FAILURE AND CONTINUE
          // --------------------------------------------------

          failed++;

          results.push({
            id: integration.id,
            integration: integration.integration_id,
            result: "failed",
            error: error.message
          });

        }
      }

      // ------------------------------------------------------
      // FINAL RESPONSE
      // ------------------------------------------------------

      return json({
        success: true,
        processed: true,
        total_found: disconnectedRows.length,
        composio_deleted: composioDeleted,
        composio_already_missing: alreadyMissing,
        database_deleted: databaseDeleted,
        failed: failed,
        results: results
      });

    } catch (error) {

      return json({
        success: false,
        error: error.message
      }, 500);

    }
  }
};

// ============================================================
// RESPONSE HELPERS
// ============================================================

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders()
    }
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
        }
