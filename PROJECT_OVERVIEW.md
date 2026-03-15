# Wafri AI Project Overview

## Elevator pitch
Fatima is a multimodal AI vet assistant for African farmers and clinics: she sees sick animals, speaks local languages, identifies medicines on camera, and places real treatment orders quickly.

## Inspiration
This project started from a personal experience. I was once asked to restock livestock supplies at home while my mom, who is the main person caring for our birds, handed me a list of required items and several distributor contacts to call.

At first, I did not realize how difficult procurement could be. I spent hours calling different numbers, getting redirected, comparing inconsistent prices, and trying to find who actually had stock available before I could complete the list.

When I searched online for help, I found no platform that truly specialized in this workflow. The system was fragmented across calls, chats, and scattered suppliers.

That experience pushed us to investigate deeper. Through additional research and direct conversations with livestock farmers and veterinary clinics, we validated that this is a widespread, high-friction problem: people lose time and money trying to find trusted supplies at fair prices.

Wafri AI was built to solve exactly that, while also helping with field-level animal care. With Fatima, users can ask for help by voice, show an animal or medicine on camera, compare options quickly, and complete action in minutes.

## What it does
Wafri AI introduces Fatima, a real-time multimodal agent that sees, hears, and speaks with farmers like a veterinary assistant in the field.

Farmers can describe symptoms by voice or show animals on camera. Fatima triages the case, explains likely conditions in simple language, and decides whether to recommend treatment products or escalate to nearby clinics.

Fatima's diagnosis engine is backed by a comprehensive veterinary disease database of **108+ diseases and conditions** spanning 10+ species groups — equine, bovine, porcine, poultry, small ruminants (sheep and goats), canine, feline, lagomorphs (rabbits), mustelids (ferrets), and more. Every condition includes key symptoms, visual observations, non-visual (internal/subclinical) symptoms, severity level, and a complete management protocol covering pharmacological, surgical, environmental, and biosecurity interventions. Semantic similarity search using pgvector and Vertex AI Gemini embeddings matches the farmer's description to the most relevant conditions, while a differential diagnosis protocol ensures Fatima asks targeted follow-up questions before committing to any single diagnosis.

When a farmer shows an existing medicine bottle or asks for a product, Fatima reads labels, identifies the drug, searches WafriVet inventory, suggests safer or lower-cost options, and places an order linked to the farmer's phone number. Farmers then receive live SMS confirmation.

For veterinary clinics, Fatima works as a procurement copilot: staff can ask for a medicine, compare distributor prices and stock, choose the best option quickly, and place orders without spending hours calling multiple suppliers.

Farmers can also ask about order history in natural language (for example, "the drug I bought last Wednesday"), and Fatima retrieves current status such as paid, shipped, or delivered.

## How we built it
The frontend is built with Next.js and streams microphone plus camera context into Gemini Live, while rendering Fatima's voice interaction and UI state in real time. Sensitive authentication inputs are handled in secure overlays and not passed through the model.

The backend is FastAPI deployed on Google Cloud Run. It manages one live session per farmer, orchestrates ADK tool-calling for diagnosis, product discovery, clinic escalation, and ordering, and emits real-time updates over WebSockets with Redis pub/sub.

Supabase Postgres stores operational data including farmers, products, distributors, carts, and orders. We combine pgvector and full-text search for robust medicine retrieval and use migration-driven schema updates for safety. The disease knowledge base is stored in a dedicated `disease_content` table with 3072-dimensional Vertex AI Gemini embeddings per condition, enabling sub-second semantic symptom matching across 108+ diseases.

Google Maps Geocoding and Google Places API (New) resolve location and nearest clinics. Termii and Africa's Talking connect the experience to real SMS, voice, and USSD channels for rural conditions.

## Challenges we ran into
The biggest product challenge was making Fatima genuinely agentic rather than scripted: deciding when to diagnose, when to sell, when to ask follow-up questions, and when to escalate to a clinic.

We also had to enforce secure session isolation without full traditional auth from day one. Early cart/session leakage risks required anonymous JWT sessions, phone plus PIN flows, and strict row-level security policies.

Another major challenge was reliability under weak network conditions. We tuned media quality, reconnect behavior, and tool orchestration so the flow remains stable enough for real-world usage and live demo capture.

## Accomplishments that we're proud of
We built a true "see, hear, speak" veterinary agent that can assess a sick chicken from live video, explain likely issues clearly, identify medicine labels on camera, and place a real order quickly.

We completed the end-to-end commerce loop: cart creation, intelligent product selection, order placement, payment-state updates, and instant SMS confirmation in a live conversation.

We also implemented production-minded security and scale foundations, including session controls, phone plus PIN authentication, Redis-backed controls, and row-level data protection.

## What we learned
The strongest AI products are not judged by model complexity alone; they are judged by whether real people can solve urgent problems with confidence.

We learned that multimodal AI becomes significantly more useful when treated as a stateful agent with tools, memory, and constraints, not just a voice wrapper over static endpoints.

We also learned that operational details, such as security, session handling, and resilience, are what transform a compelling prototype into a deployable system.

Most importantly, we learned that this kind of agent gives time back to the people who keep food and animal health systems running. Reducing procurement friction and diagnostic delays creates compounding value across the local economy.

## What's next for Wafri AI
In the near term, we are expanding language coverage (Pidgin, Hausa, Yoruba, Igbo, and French) and improving triage quality across more livestock species and disease profiles with local veterinary input.

We are integrating additional payment rails and logistics partners so Fatima can autonomously choose the best distributor and delivery pathway per farmer and clinic.

We are also adding clinic-first procurement workflows, including bulk ordering, repeat order templates, and faster price comparison across verified distributors.

Longer term, we will extend access beyond smartphones through USSD and voice-only paths, allowing farmers with basic feature phones to receive fast, AI-powered veterinary support across West Africa.

Our broader vision is to lead the next generation of immersive procurement and assistance agents that can be reconfigured across sectors such as veterinary medicine, human pharmacy, and frontline healthcare supply chains.

We believe Wafri AI can contribute directly to key UN Sustainable Development Goals in Africa:
- SDG 1 - No Poverty
- SDG 2 - Zero Hunger
- SDG 3 - Good Health and Well-Being
- SDG 8 - Decent Work and Economic Growth
- SDG 9 - Industry, Innovation and Infrastructure
