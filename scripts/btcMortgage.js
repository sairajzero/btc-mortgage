(function (EXPORTS) {
    const btcMortgage = EXPORTS;

    //USERS: B: Borrower, L: Lender, C: Collateral provider, T: Trusted banker (us)

    var BankerPubKey = "0257a9c47462fe89b159daa204ddb964c9b098a020641cc8090a9cad4f6dd2172a";

    const CURRENCY = "USD";

    const PERIOD_REGEX = /^\d{1,5}(Y|M|D)$/,
        TXID_REGEX = /^[0-9a-f]{64}$/i,
        VALUE_REGEX = /^\d+(.\d{1,8})?$/;

    const
        TYPE_LOAN_COLLATERAL_REQUEST = "type_loan_collateral_request",
        TYPE_LOAN_REQUEST = "type_loan_request",
        TYPE_LENDER_RESPONSE = "type_loan_response",
        TYPE_COLLATERAL_LOCK_REQUEST = "type_collateral_lock_request",
        TYPE_COLLATERAL_LOCK_ACK = "type_collateral_lock_ack"

    const POLICIES = {}

    const toFixedDecimal = value => parseFloat((value).toFixed(8));

    function encodePeriod(str) {

        if (typeof str != 'string')
            throw "passed value must be string";

        if (PERIOD_REGEX.test(str)) //already in format
            return str;

        let P = '', n = 0;
        str.toLowerCase().replace(/,/g, '').split(" ").forEach(s => {
            if (!isNaN(s))
                n = parseInt(s);
            else switch (s) {
                case "year(s)": case "year": case "years": P += (n + 'Y'); n = 0; break;
                case "month(s)": case "month": case "months": P += (n + 'M'); n = 0; break;
                case "day(s)": case "day": case "days": P += (n + 'D'); n = 0; break;
            }
        });

        if (!PERIOD_REGEX.test(P)) {//not in format: something wrong
            console.error(`encodePeriod('${str}') failed`, P)
            throw "Invalid period";
        }

        return P;
    }

    function decodePeriod(str) {
        if (typeof str != 'string')
            throw "passed value must be string";

        else if (!PERIOD_REGEX.test(str)) //not in format
            throw "Invalid period";

        let n = parseInt(str);
        let v = str[str.length - 1];

        switch (v) {
            case 'Y': return n + (n == 1 ? "year" : "years");
            case 'M': return n + (n == 1 ? "month" : "months");
            case "D": return n + (n == 1 ? "day" : "days");
        }

    }

    const dateFormat = (date = null) => {
        let d = (date ? new Date(date) : new Date()).toDateString();
        return [d.substring(8, 10), d.substring(4, 7), d.substring(11, 15)].join(" ");
    }
    const yearDiff = (d1 = null, d2 = null) => {
        d1 = d1 ? new Date(d1) : new Date();
        d2 = d2 ? new Date(d2) : new Date();
        let y = d1.getYear() - d2.getYear(),
            m = d1.getMonth() - d2.getMonth(),
            d = d1.getDate() - d2.getDate()
        return y + m / 12 + d / 365;
    }

    const dateAdder = function (start_date, duration) {
        let date = new Date(start_date);
        let y = parseInt(duration.match(/\d+Y/)),
            m = parseInt(duration.match(/\d+M/)),
            d = parseInt(duration.match(/\d+D/));
        if (!isNaN(y))
            date.setFullYear(date.getFullYear() + y);
        if (!isNaN(m))
            date.setMonth(date.getMonth() + m);
        if (!isNaN(d))
            date.setDate(date.getDate() + d);
        return date;
    }

    function calcAllowedLoan(collateralQuantity, security_percent) {
        return collateralQuantity * security_percent;
    }

    function calcRequiredCollateral(loanEquivalent, security_percent) {
        let inverse_security_percent = 1 / security_percent;
        return loanEquivalent * inverse_security_percent;
    }

    function findLocker(coborrower_pubKey, lender_pubKey) {
        return btcOperator.multiSigAddress([coborrower_pubKey, lender_pubKey, BankerPubKey], 2);
    }

    function extractPubKeyFromSign(sign) {
        return sign.split('.')[0];
    }

    btcMortgage.util = {
        toFixedDecimal,
        encodePeriod, decodePeriod,
        calcAllowedLoan, calcRequiredCollateral,
        findLocker, extractPubKeyFromSign
    }

    //get BTC rates
    const getRate = btcMortgage.getRate = {};

    getRate["BTC"] = function () {
        return new Promise((resolve, reject) => {
            fetch('https://api.coinlore.net/api/ticker/?id=90').then(response => {
                if (response.ok) {
                    response.json()
                        .then(result => resolve(result[0].price_usd))
                        .catch(error => reject(error));
                } else
                    reject(response.status);
            }).catch(error => reject(error));
        });
    }

    //Loan details on FLO blockchain
    const LOAN_DETAILS_IDENTIFIER = "BTC Mortage: Loan details";

    function stringifyLoanOpenData(
        borrower, loan_amount, policy_id,
        coborrower, collateral_value, collateral_lock_id,
        lender, loan_transfer_id,
        borrower_sign, coborrower_sign, lender_sign
    ) {
        return [
            LOAN_DETAILS_IDENTIFIER,
            "Borrower:" + floCrypto.toFloID(borrower),
            "Amount:" + loan_amount,
            "Policy:" + policy_id,
            "CoBorrower:" + floCrypto.toFloID(coborrower),
            "CollateralValue:" + collateral_value + "BTC",
            "CollateralLock:" + collateral_lock_id,
            "Lender:" + floCrypto.toFloID(lender),
            "TokenTransfer:" + loan_transfer_id,
            "Signature-B:" + borrower_sign,
            "Signature-C:" + coborrower_sign,
            "Signature-L:" + lender_sign
        ].join('|');
        /*MAYDO: Maybe make it a worded sentence?
            BTC Mortage: 
            L#${lender_floid} is lending ${loan_amount}USD (ref#${loan_transfer_id}) to B#${borrower_floid}
            inaccoradance with policy#${policy_id} 
            as mortage on collateral#${collateral_id} (${btc_amount}BTC) provided by C#${coborrower_floid}.
            Signed by B'${borrower_sign} , C'{coborrower_sign} and L'${lender_sign}    
        */
    }

    function parseLoanOpenData(str, tx_time) {
        let splits = str.split('|');
        if (splits[0] !== LOAN_DETAILS_IDENTIFIER)
            throw "Invalid Loan blockchain data";
        var details = { open_time: tx_time };
        splits.forEach(s => {
            let d = s.split(':');
            switch (d[0]) {
                case "Borrower": details.borrower = d[1]; break;
                case "Amount": details.loan_amount = parseFloat(d[1]); break;
                case "Policy": details.policy_id = d[1]; break;
                case "CoBorrower": details.coborrower = d[1]; break;
                case "CollateralValue": details.collateral_value = parseFloat(d[1]); break;
                case "CollateralLock": details.collateral_lock_id = d[1]; break;
                case "Lender": details.lender = d[1]; break;
                case "TokenTransfer": details.loan_transfer_id = d[1]; break;
                case "Signature-B": details.borrower_sign = d[1]; break;
                case "Signature-C": details.coborrower_sign = d[1]; break;
                case "Signature-L": details.lender_sign = d[1]; break;
            }
        });
        return details;
    }

    /*Loan taking*/

    //1. B: requests collateral from coborrower
    btcMortgage.requestLoanCollateral = function (loan_amount, policy_id, coborrower) {
        return new Promise((resolve, reject) => {
            const borrower = floDapps.user.id;
            //Input validation
            if (typeof loan_amount !== 'number' && loan_amount <= 0)
                return reject("Invalid loan amount: " + loan_amount);
            loan_amount = toFixedDecimal(loan_amount); //decimal allowed upto 8 decimal places
            if (!(policy_id in POLICIES))
                return reject("Invalid policy: " + policy_id);
            if (!floCrypto.validateAddr(coborrower))
                return reject("Invalid coborrower id")
            //request collateral from coborrower
            floCloudAPI.sendApplicationData({
                borrower, coborrower,
                loan_amount, policy_id
            }, TYPE_LOAN_COLLATERAL_REQUEST, { receiverID: coborrower })
                .then(result => resolve(result))
                .catch(error => reject(error))
        })
    }

    function validate_loanCollateral_request(loan_collateral_req_id, borrower, coborrower) {
        return new Promise((resolve, reject) => {
            floCloudAPI.requestApplicationData(TYPE_LOAN_COLLATERAL_REQUEST, { atVectorClock: loan_collateral_req_id }).then(loan_collateral_req => {
                if (!loan_collateral_req.length)
                    return reject(RequestValidationError(TYPE_LOAN_REQUEST, "request not found"));
                loan_collateral_req = loan_collateral_req[0];
                if (!floCrypto.isSameAddr(loan_collateral_req.senderID, borrower))
                    return reject(RequestValidationError(TYPE_LOAN_COLLATERAL_REQUEST, "sender is not borrower"));
                if (!floCrypto.isSameAddr(loan_collateral_req.receiverID, coborrower))
                    return reject(RequestValidationError(TYPE_LOAN_COLLATERAL_REQUEST, "receiver is not coborrower"));
                let { loan_amount, policy_id } = loan_collateral_req.message;
                if (typeof loan_amount !== 'number' && loan_amount <= 0 || VALUE_REGEX.test(loan_amount))
                    return reject(RequestValidationError(TYPE_LOAN_COLLATERAL_REQUEST, "Invalid loan amount"));
                if (!(policy_id in POLICIES))
                    return reject(RequestValidationError(TYPE_LOAN_COLLATERAL_REQUEST, "Invalid policy"));
                let result = { loan_amount, policy_id, borrower, coborrower };
                result.borrower_pubKey = loan_collateral_req.pubKey;
                resolve(result);
            }).catch(error => reject(error))
        })
    }

    //2. B: post loan request (with proof of collateral)
    btcMortgage.requestLoan = function (loan_collateral_req_id, borrower) {
        return new Promise((resolve, reject) => {
            const coborrower = floDapps.user.id;
            //validate request
            validate_loanCollateral_request(loan_collateral_req_id, borrower, coborrower).then(({ loan_amount, policy_id }) => {
                //calculate required collateral
                getRate["BTC"].then(rate => {
                    let policy = POLICIES[policy_id];
                    let collateral_value = calcRequiredCollateral(loan_amount * rate, policy.security_percent)
                    //check if collateral is available
                    let coborrower_floID = floCrypto.toFloID(coborrower);
                    let coborrower_btcID = btcOperator.convert.legacy2bech(coborrower_floID);
                    btcOperator.getBalance(coborrower_btcID).then(coborrower_balance => {
                        if (coborrower_balance < collateral_value)
                            return reject("Insufficient collateral available");
                        //post request
                        floCloudAPI.sendApplicationData({
                            borrower, coborrower,
                            loan_amount, policy_id, loan_collateral_req_id,
                            collateral: {
                                btc_id: coborrower_btcID,
                                quantity: collateral_value
                            }
                        }, TYPE_LOAN_REQUEST)
                            .then(result => resolve(result))
                            .catch(error => reject(error))
                    }).catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    function validate_loan_request(loan_req_id, borrower, coborrower) {
        return new Promise((resolve, reject) => {
            floCloudAPI.requestApplicationData(TYPE_LOAN_REQUEST, { atVectorClock: loan_req_id }).then(loan_req => {
                if (!loan_req.length)
                    return reject(RequestValidationError(TYPE_LOAN_REQUEST, "request not found"));
                loan_req = loan_req[0];
                if (!floCrypto.isSameAddr(coborrower, loan_req.senderID))
                    return reject(RequestValidationError(TYPE_LOAN_REQUEST, "request not posted by coborrower"))
                let { loan_collateral_req_id, loan_amount, policy_id, collateral } = loan_req.message;
                if (!floCrypto.isSameAddr(collateral.btc_id, coborrower))
                    return reject(RequestValidationError(TYPE_LOAN_REQUEST, "collateral btc id is not coborrower"));
                validate_loanCollateral_request(loan_collateral_req_id, borrower, coborrower).then(result => {
                    if (result.loan_amount !== loan_amount)
                        return reject(RequestValidationError(TYPE_LOAN_REQUEST, "loan amount mismatch"));
                    if (policy_id !== result.policy_id)
                        return reject(RequestValidationError(TYPE_LOAN_REQUEST, "policy id mismatch"));
                    getRate["BTC"].then(rate => {
                        let policy = POLICIES[policy_id];
                        let required_collateral = calcRequiredCollateral(loan_amount * rate, policy.security_percent)
                        if (required_collateral > collateral.quantity)
                            return reject(RequestValidationError(TYPE_LOAN_REQUEST, "Insufficient collateral value"));
                        //check if collateral is available
                        btcOperator.getBalance(collateral.btc_id).then(coborrower_balance => {
                            if (coborrower_balance < collateral.quantity)
                                return reject(RequestValidationError(TYPE_LOAN_REQUEST, "Insufficient collateral available"));
                            result.collateral = collateral;
                            result.coborrower_pubKey = loan_req.pubKey;
                            resolve(result)
                        }).catch(error => reject(error))
                    }).catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })

    }

    //3. L: respond to loan request
    btcMortgage.respondLoan = function (loan_req_id, borrower, coborrower) {
        return new Promise((resolve, reject) => {
            const lender = floDapps.user.id;
            validate_loan_request(loan_req_id, borrower, coborrower).then(({ loan_amount, borrower }) => {
                //check if loan amount (token) is available to lend
                let lender_floID = floCrypto.toFloID(lender);
                floTokenAPI.getBalance(lender_floID).then(lender_tokenBalance => {
                    if (lender_tokenBalance < loan_amount)
                        return reject("Insufficient tokens to lend");
                    floCloudAPI.sendApplicationData({
                        lender, borrower, coborrower,
                        loan_req_id
                    }, TYPE_LENDER_RESPONSE, { receiverID: borrower })
                        .then(result => resolve(result))
                        .catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    function validate_lender_response(lender_res_id, borrower, coborrower, lender) {
        return new Promise((resolve, reject) => {
            floCloudAPI.requestApplicationData(TYPE_LENDER_RESPONSE, { atVectorClock: lender_res_id, receiverID: borrower }).then(lender_res => {
                if (!lender_res.length)
                    return reject(RequestValidationError(TYPE_LENDER_RESPONSE, "response not found"));
                lender_res = lender_res[0];
                if (!floCrypto.isSameAddr(lender, lender_res.senderID))
                    return reject(RequestValidationError(TYPE_LENDER_RESPONSE, "response not sent by lender"))
                let { loan_req_id } = lender_res.message;
                validate_loan_request(loan_req_id, borrower, coborrower).then(result => {
                    let { loan_amount } = result;
                    //check if loan amount (token) is available to lend
                    let lender_floID = floCrypto.toFloID(lender);
                    floTokenAPI.getBalance(lender_floID).then(lender_tokenBalance => {
                        if (lender_tokenBalance < loan_amount)
                            return reject(RequestValidationError(TYPE_LENDER_RESPONSE, "lender doesnot have sufficient funds to lend"));
                        result.lender = lender;
                        result.lender_pubKey = lender_res.pubKey;
                        resolve(result);
                    }).catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    //4. B: requests C to lock the collateral 
    btcMortgage.requestCollateralLock = function (lender_res_id, coborrower, lender, privKey) {
        return new Promise((resolve, reject) => {
            const borrower = floDapps.user.id;
            validate_lender_response(lender_res_id, borrower, coborrower, lender).then(({ loan_amount, policy_id }) => {
                //send request to coborrower for locking the collateral asset
                let borrower_sign = sign_borrower(privKey, loan_amount, policy_id, lender);
                floCloudAPI.sendApplicationData({
                    lender, borrower, coborrower,
                    lender_res_id, borrower_sign
                }, TYPE_COLLATERAL_LOCK_REQUEST, { receiverID: collateral.provider })
                    .then(result => resolve(result))
                    .catch(error => reject(error))
            }).catch(error => reject(error))
        }).catch(error => reject(error))
    }

    function validate_collateralLock_request(collateral_lock_req_id, borrower, coborrower, lender) {
        return new Promise((resolve, reject) => {
            floCloudAPI.requestApplicationData(TYPE_COLLATERAL_LOCK_REQUEST, { atVectorClock: collateral_lock_req_id, receiverID: coborrower }).then(collateral_lock_req => {
                if (!collateral_lock_req.length)
                    return reject(RequestValidationError(TYPE_COLLATERAL_LOCK_REQUEST, "request not found"));
                collateral_lock_req = collateral_lock_req[0];
                if (!floCrypto.isSameAddr(borrower, collateral_lock_req.senderID))
                    return reject(RequestValidationError(TYPE_LENDER_RESPONSE, "request not sent by borrower"));
                let { lender_res_id, borrower_sign } = collateral_lock_req.message;
                validate_lender_response(lender_res_id, borrower, coborrower, lender).then(result => {
                    let { loan_amount, policy_id } = result;
                    //verify borrower_sign
                    let borrower_sign_time = verify_borrowerSign(borrower_sign, borrower, loan_amount, policy_id, lender)
                    if (!borrower_sign_time) //MAYDO: expire signatures?
                        return reject("Invalid borrower signature");
                    result.borrower_sign = borrower_sign;
                    resolve(result);
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    //5. C: locks required collateral in multisig (C, L, T)
    btcMortgage.lockCollateral = function (collateral_lock_req_id, borrower, lender, privKey) {
        return new Promise((resolve, reject) => {
            const coborrower = floDapps.user.id;
            validate_collateralLock_request(collateral_lock_req_id, borrower, coborrower, lender).then(({ borrower_sign, collateral, lender_pubKey }) => {
                //lock collateral
                lockCollateralInBlockchain(privKey, lender_pubKey, collateral.quantity).then(collateral_txid => {
                    //sign and request lender to finalize
                    let coborrower_sign = sign_coborrower(privKey, borrower_sign, collateral.quantity, collateral_txid)
                    floCloudAPI.sendApplicationData({
                        borrower, coborrower, lender,
                        collateral_lock_id: collateral_txid,
                        coborrower_sign, collateral_lock_req_id
                    }, TYPE_COLLATERAL_LOCK_ACK, { receiverID: lender })
                        .then(result => resolve(result))
                        .catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    function lockCollateralInBlockchain(privKey, lenderPubKey, collateral_value) {
        return new Promise((resolve, reject) => {
            const locker_id = findLocker(floDapps.user.public, lenderPubKey).address;
            btcOperator.sendTx(floDapps.user.id, privKey, locker_id, collateral_value)
                .then(txid => resolve(txid))
                .catch(error => reject(error))
        })
    }

    function validate_collateralLock_ack(collateral_lock_ack_id, borrower, coborrower, lender) {
        return new Promise((resolve, reject) => {
            floCloudAPI.requestApplicationData(TYPE_COLLATERAL_LOCK_ACK, { atVectorClock: collateral_lock_ack_id, receiverID: lender }).then(collateral_lock_ack => {
                if (!collateral_lock_ack.length)
                    return reject(RequestValidationError(TYPE_COLLATERAL_LOCK_REQUEST, "request not found"));
                collateral_lock_ack = collateral_lock_ack[0];
                if (!floCrypto.isSameAddr(borrower, collateral_lock_ack.senderID))
                    return reject(RequestValidationError(TYPE_LENDER_RESPONSE, "request not sent by borrower"));
                let { collateral_lock_req_id, coborrower_sign, collateral_lock_id } = collateral_lock_ack.message;
                validate_collateralLock_request(collateral_lock_req_id, borrower, coborrower, lender).then(result => {
                    let { borrower_sign, collateral } = result;
                    let coborrower_sign_time = verify_coborrowerSign(coborrower_sign, coborrower, borrower_sign, collateral.quantity, collateral_lock_id)
                    if (!coborrower_sign_time) //MAYDO: expire signatures?
                        return reject(RequestValidationError(TYPE_COLLATERAL_LOCK_ACK, "Invalid coborrower signature"));
                    btcOperator.getTx(collateral_lock_id).then(collateral_tx => {
                        if (!collateral_tx.confirmations)
                            return reject(RequestValidationError(TYPE_COLLATERAL_LOCK_ACK, "Collateral lock transaction not confirmed yet"));
                        let locker_id = findLocker(finalize_request.pubKey, lender_response.pubKey).address;
                        let locked_amt = collateral_tx.outputs.filter(o => o.address == locker_id).reduce((a, o) => a += o.value, 0);
                        if (locked_amt < collateral.quantity)
                            return reject(RequestValidationError(TYPE_COLLATERAL_LOCK_ACK, "Insufficient Collateral locked"));
                        //TODO: make sure same collateral is not reused?
                        result.coborrower_sign = coborrower_sign;
                        result.collateral_lock_id = collateral_lock_id;
                        resolve(result);
                    }).catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    //6. L: sends loan amount (USD tokens) to B and writes loan details in flo blockchain
    btcMortgage.sendLoanAmount = function (collateral_lock_ack_id, borrower, coborrower, privKey) {
        return new Promise((resolve, reject) => {
            const lender = floDapps.user.id;
            validate_collateralLock_ack(collateral_lock_ack_id, borrower, coborrower, lender).then(result => {
                let { loan_amount, policy_id, collateral, borrower_sign, coborrower_sign } = result;
                //transfer tokens for loan amount
                floTokenAPI.sendToken(privKey, loan_amount, borrower, "as loan", CURRENCY).then(token_txid => {
                    //construct the blockchain data
                    let lender_sign = sign_lender(privKey, coborrower_sign, token_txid);
                    let blockchainData = stringifyLoanOpenData(
                        borrower, loan_amount, policy_id,
                        coborrower, collateral.quantity, collateral_lock_id,
                        lender, token_txid,
                        borrower_sign, coborrower_sign, lender_sign
                    );
                    let receivers = [borrower, coborrower].map(addr => floCrypto.toFloID(addr));
                    //write loan details in blockchain
                    floBlockchainAPI.writeDataMultiple([privKey], blockchainData, receivers)
                        .then(result => resolve(result))
                        .catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))

        })
    }

})(window.btcMortgage = {})