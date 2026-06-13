import os, json, stripe
from http.server import BaseHTTPRequestHandler

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "")


class handler(BaseHTTPRequestHandler):

    def do_POST(self):
        try:
            session = stripe.checkout.Session.create(
                payment_method_types=["card"],
                line_items=[{"price": os.environ["STRIPE_PRICE_ID"], "quantity": 1}],
                mode="payment",
                success_url=os.environ["SITE_URL"] + "/success?session_id={CHECKOUT_SESSION_ID}",
                cancel_url=os.environ["SITE_URL"] + "/#pricing",
                billing_address_collection="auto",
            )
            self._respond(200, {"url": session.url})
        except Exception as e:
            self._respond(500, {"error": str(e)})

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def _respond(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", os.environ.get("SITE_URL", "*"))
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def log_message(self, format, *args):
        pass
