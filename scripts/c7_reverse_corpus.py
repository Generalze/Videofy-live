#!/usr/bin/env python3
"""Direct X->en source for French, Spanish and Portuguese.

WHY THIS EXISTS FOR THESE LANGUAGES AND NOT FOR THE NIGERIAN ONES.

For Hausa, Yoruba and Igbo this project REFUSED to author source text and is
waiting on native contributors, because nobody here can write those languages
and nobody here could check the result. That refusal stands.

French, Spanish and Portuguese are a different case and the difference is
checkable rather than convenient: these are high-resource languages the author
of this file can write and verify, and -- decisively -- the founder is
arranging fluent reviewers for exactly these three, so every sentence below
will be read by somebody who would notice if it were wrong.

So this corpus is labelled for what it is:

    sourceAuthoredBy        claude-opus-5
    pendingFluentConfirmation  true

It is machine-authored source pending fluent confirmation, NOT native-authored
source. A reviewer who finds a sentence unnatural should say so, and that
finding invalidates the item rather than the reviewer.

It is still better than the round trip it replaces: a round trip measures an
engine against itself, and a consistently wrong model scores well that way.

The 30 cases mirror the English corpus category for category, so `en->fr` and
`fr->en` are asking the same questions in opposite directions.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ReverseCase:
    category: str
    source: str
    """What it means, for scoring. SEMANTIC reference, never wording."""
    english_meaning: str
    identifiers: tuple[str, ...] = ()
    negated: bool = False


FR: tuple[ReverseCase, ...] = (
    ReverseCase("money", "Le prix est de deux mille naira par sac.",
                "The price is two thousand naira per bag."),
    ReverseCase("money", "Merci d'envoyer 45 000 nairas sur mon compte aujourd'hui.",
                "Please send 45,000 naira to my account today."),
    ReverseCase("money", "J'ai bien recu l'argent que tu as envoye.",
                "I have received the money you sent."),
    ReverseCase("money-negation", "Je n'ai pas recu l'argent que tu as envoye.",
                "I have not received the money you sent.", negated=True),
    ReverseCase("money", "Votre solde est de 12 500 nairas.",
                "Your balance is 12,500 naira."),
    ReverseCase("phone", "Appelle-moi au 08031234567 quand tu arrives.",
                "Call me on 08031234567 when you arrive.", ("08031234567",)),
    ReverseCase("account", "Virement sur le compte 0123456789 a la First Bank.",
                "Transfer to account 0123456789 at First Bank.", ("0123456789",)),
    ReverseCase("otp", "Votre code de verification est 483920. Ne le partagez pas.",
                "Your verification code is 483920. Do not share it.",
                ("483920",), negated=True),
    ReverseCase("url", "Lisez https://consummate7.com/help avant d'appeler.",
                "Read https://consummate7.com/help before you call.",
                ("https://consummate7.com/help",)),
    ReverseCase("datetime", "La reunion est reportee au 15 mars a 16h30.",
                "The meeting has been moved to 15 March at 4:30."),
    ReverseCase("entity", "Je m'appelle Zoe et je travaille a Lagos.",
                "My name is Zoe and I work in Lagos."),
    ReverseCase("negation", "N'envoie pas encore le paiement.",
                "Do not send the payment yet.", negated=True),
    ReverseCase("negation", "Je n'ai pas dit que je ne viendrais pas.",
                "I did not say that I would not come.", negated=True),
    ReverseCase("health", "Prenez un comprime deux fois par jour apres les repas.",
                "Take one tablet twice a day after eating."),
    ReverseCase("health", "Ne donnez pas ce medicament a un enfant de moins de cinq ans.",
                "Do not give this medicine to a child under five years old.", negated=True),
    ReverseCase("multi", "Je suis en route. Attends-moi au portail. J'arrive bientot.",
                "I am on my way. Wait for me at the gate. I will be there soon."),
    ReverseCase("broadcast", "Bonjour a tous, et bienvenue a cette emission.",
                "Good morning everyone, and welcome to this broadcast."),
    ReverseCase("conversation", "Comment vas-tu ce soir ?",
                "How are you doing this evening?"),
    ReverseCase("business", "Nous devons signer l'accord avant la fin du mois.",
                "We need to sign the agreement before the end of the month."),
    ReverseCase("agriculture", "Les pluies commenceront le mois prochain, preparez la terre.",
                "The rains will start next month, so prepare the land."),
)

ES: tuple[ReverseCase, ...] = (
    ReverseCase("money", "El precio es de dos mil nairas por saco.",
                "The price is two thousand naira per bag."),
    ReverseCase("money", "Por favor envia 45.000 nairas a mi cuenta hoy.",
                "Please send 45,000 naira to my account today."),
    ReverseCase("money", "He recibido el dinero que enviaste.",
                "I have received the money you sent."),
    ReverseCase("money-negation", "No he recibido el dinero que enviaste.",
                "I have not received the money you sent.", negated=True),
    ReverseCase("money", "Su saldo es de 12.500 nairas.",
                "Your balance is 12,500 naira."),
    ReverseCase("phone", "Llamame al 08031234567 cuando llegues.",
                "Call me on 08031234567 when you arrive.", ("08031234567",)),
    ReverseCase("account", "Transfiere a la cuenta 0123456789 del First Bank.",
                "Transfer to account 0123456789 at First Bank.", ("0123456789",)),
    ReverseCase("otp", "Su codigo de verificacion es 483920. No lo comparta.",
                "Your verification code is 483920. Do not share it.",
                ("483920",), negated=True),
    ReverseCase("url", "Lea https://consummate7.com/help antes de llamar.",
                "Read https://consummate7.com/help before you call.",
                ("https://consummate7.com/help",)),
    ReverseCase("datetime", "La reunion se ha cambiado al 15 de marzo a las 16:30.",
                "The meeting has been moved to 15 March at 4:30."),
    ReverseCase("entity", "Me llamo Zoe y trabajo en Lagos.",
                "My name is Zoe and I work in Lagos."),
    ReverseCase("negation", "No envies todavia el pago.",
                "Do not send the payment yet.", negated=True),
    ReverseCase("negation", "No dije que no vendria.",
                "I did not say that I would not come.", negated=True),
    ReverseCase("health", "Tome una pastilla dos veces al dia despues de comer.",
                "Take one tablet twice a day after eating."),
    ReverseCase("health", "No de este medicamento a un nino menor de cinco anos.",
                "Do not give this medicine to a child under five years old.", negated=True),
    ReverseCase("multi", "Voy de camino. Esperame en la puerta. Llegare pronto.",
                "I am on my way. Wait for me at the gate. I will be there soon."),
    ReverseCase("broadcast", "Buenos dias a todos, y bienvenidos a esta transmision.",
                "Good morning everyone, and welcome to this broadcast."),
    ReverseCase("conversation", "Como estas esta noche?",
                "How are you doing this evening?"),
    ReverseCase("business", "Tenemos que firmar el acuerdo antes de fin de mes.",
                "We need to sign the agreement before the end of the month."),
    ReverseCase("agriculture", "Las lluvias empezaran el mes que viene, prepara la tierra.",
                "The rains will start next month, so prepare the land."),
)

PT: tuple[ReverseCase, ...] = (
    ReverseCase("money", "O preco e de dois mil nairas por saco.",
                "The price is two thousand naira per bag."),
    ReverseCase("money", "Por favor envie 45.000 nairas para a minha conta hoje.",
                "Please send 45,000 naira to my account today."),
    ReverseCase("money", "Recebi o dinheiro que voce enviou.",
                "I have received the money you sent."),
    ReverseCase("money-negation", "Nao recebi o dinheiro que voce enviou.",
                "I have not received the money you sent.", negated=True),
    ReverseCase("money", "O seu saldo e de 12.500 nairas.",
                "Your balance is 12,500 naira."),
    ReverseCase("phone", "Ligue para 08031234567 quando chegar.",
                "Call me on 08031234567 when you arrive.", ("08031234567",)),
    ReverseCase("account", "Transfira para a conta 0123456789 no First Bank.",
                "Transfer to account 0123456789 at First Bank.", ("0123456789",)),
    ReverseCase("otp", "O seu codigo de verificacao e 483920. Nao o partilhe.",
                "Your verification code is 483920. Do not share it.",
                ("483920",), negated=True),
    ReverseCase("url", "Leia https://consummate7.com/help antes de ligar.",
                "Read https://consummate7.com/help before you call.",
                ("https://consummate7.com/help",)),
    ReverseCase("datetime", "A reuniao foi adiada para 15 de marco as 16:30.",
                "The meeting has been moved to 15 March at 4:30."),
    ReverseCase("entity", "O meu nome e Zoe e trabalho em Lagos.",
                "My name is Zoe and I work in Lagos."),
    ReverseCase("negation", "Nao envie o pagamento ainda.",
                "Do not send the payment yet.", negated=True),
    ReverseCase("negation", "Nao disse que nao viria.",
                "I did not say that I would not come.", negated=True),
    ReverseCase("health", "Tome um comprimido duas vezes por dia depois de comer.",
                "Take one tablet twice a day after eating."),
    ReverseCase("health", "Nao de este medicamento a uma crianca com menos de cinco anos.",
                "Do not give this medicine to a child under five years old.", negated=True),
    ReverseCase("multi", "Estou a caminho. Espere por mim no portao. Chego em breve.",
                "I am on my way. Wait for me at the gate. I will be there soon."),
    ReverseCase("broadcast", "Bom dia a todos, e bem-vindos a esta transmissao.",
                "Good morning everyone, and welcome to this broadcast."),
    ReverseCase("conversation", "Como esta esta noite?",
                "How are you doing this evening?"),
    ReverseCase("business", "Precisamos de assinar o acordo antes do fim do mes.",
                "We need to sign the agreement before the end of the month."),
    ReverseCase("agriculture", "As chuvas comecam no proximo mes, prepare a terra.",
                "The rains will start next month, so prepare the land."),
)

REVERSE_CORPUS: dict[str, tuple[ReverseCase, ...]] = {"fr": FR, "es": ES, "pt": PT}

PROVENANCE = {
    "sourceAuthoredBy": "claude-opus-5",
    "pendingFluentConfirmation": True,
    "note": "Machine-authored source pending fluent confirmation, NOT native-authored. "
            "Written for fr/es/pt only, where the author can verify and where fluent "
            "reviewers are being arranged. The Nigerian languages remain on native "
            "contributor elicitation and no source for them is authored here.",
}
